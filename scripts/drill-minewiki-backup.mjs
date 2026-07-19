#!/usr/bin/env node

import './load-environment.mjs';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseMysqlDatabaseUrl, resolveSafeDirectory } from './minewiki-backup-contract.mjs';

const snapshotArgument = process.argv.slice(2).find((argument) => argument !== '--');
const snapshot = resolveSafeDirectory(snapshotArgument, { label: 'snapshot path' });
const manifest = JSON.parse(await readFile(path.join(snapshot, 'manifest.json'), 'utf8'));
if (!manifest.verification?.verifiedAt) throw new Error('Restore drills require a verified backup manifest.');

const database = parseMysqlDatabaseUrl(
  process.env.MINEWIKI_DRILL_DATABASE_URL || process.env.DATABASE_URL,
);
const drillDatabase = `minewiki_restore_drill_${Date.now()}_${randomBytes(4).toString('hex')}`;
const mysqlArgs = ['--host', database.host, '--port', database.port, '--user', database.user, '--batch', '--skip-column-names'];
const env = { MYSQL_PWD: database.password };
const uploadRestoreRoot = await mkdtemp(path.join(os.tmpdir(), 'minewiki-upload-restore-drill-'));

try {
  await mysql([...mysqlArgs, '--execute', `CREATE DATABASE \`${drillDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`], env);
  await mysql([...mysqlArgs, drillDatabase], env, path.join(snapshot, manifest.database.artifact));
  const output = await mysql([
    ...mysqlArgs,
    drillDatabase,
    '--execute',
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE(); SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('Account','Server','pages','_prisma_migrations');",
  ], env);
  const [tableCount, criticalTableCount] = output.trim().split(/\s+/u).map(Number);
  if (!Number.isInteger(tableCount) || tableCount < 4) throw new Error('Restored database contains too few tables.');
  if (criticalTableCount !== 4) throw new Error('Restored database is missing a critical MineWiki table.');
  const criticalRowsOutput = await mysql([
    ...mysqlArgs,
    drillDatabase,
    '--execute',
    'SELECT (SELECT COUNT(*) FROM Account), (SELECT COUNT(*) FROM Server), (SELECT COUNT(*) FROM pages), (SELECT COUNT(*) FROM _prisma_migrations);',
  ], env);
  const [accounts, servers, pages, migrations] = criticalRowsOutput.trim().split(/\s+/u).map(Number);
  if (![accounts, servers, pages, migrations].every(Number.isSafeInteger) || migrations < 1) {
    throw new Error('Restored database critical row invariants are invalid.');
  }
  await extractUploads(path.join(snapshot, manifest.uploads.artifact), uploadRestoreRoot);
  const uploads = await countRestoredFiles(uploadRestoreRoot);
  if (uploads.files !== manifest.uploads.files || uploads.bytes !== manifest.uploads.sourceBytes) {
    throw new Error('Restored uploads do not match the backup manifest.');
  }
  const evidence = {
    schemaVersion: 1,
    snapshotId: manifest.snapshotId,
    drilledAt: new Date().toISOString(),
    database: { tableCount, criticalTableCount, criticalRows: { accounts, servers, pages, migrations } },
    uploads,
  };
  const evidencePath = path.join(snapshot, 'restore-drill.json');
  const temporaryEvidencePath = `${evidencePath}.tmp`;
  await writeFile(temporaryEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryEvidencePath, evidencePath);
  const remote = process.env.MINEWIKI_BACKUP_REMOTE?.trim();
  if (remote) {
    await run('rclone', ['copyto', evidencePath, `${remote.replace(/\/$/u, '')}/${manifest.snapshotId}/restore-drill.json`]);
  }
  process.stdout.write(`Restore drill passed for ${manifest.snapshotId}: ${tableCount} tables, ${uploads.files} upload files.\n`);
} finally {
  await mysql([...mysqlArgs, '--execute', `DROP DATABASE IF EXISTS \`${drillDatabase}\``], env);
  await rm(uploadRestoreRoot, { recursive: true, force: true });
}

function mysql(args, extraEnv, inputFile) {
  return new Promise((resolve, reject) => {
    const child = spawn('mysql', args, {
      stdio: [inputFile ? 'pipe' : 'ignore', 'pipe', 'inherit'],
      env: { ...process.env, ...extraEnv },
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    if (inputFile) {
      const input = createReadStream(inputFile);
      input.on('error', (error) => child.destroy(error));
      input.pipe(child.stdin);
    }
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`mysql exited with code ${code}`)));
  });
}

function extractUploads(archive, destination) {
  return run('tar', [
    '--extract', '--gzip', '--file', archive, '--directory', destination,
    '--no-same-owner', '--no-same-permissions',
  ]);
}

async function countRestoredFiles(root) {
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error(`Restored uploads contain an unsupported filesystem entry: ${entry.name}`);
    }
    if (info.isDirectory()) {
      const nested = await countRestoredFiles(target);
      files += nested.files;
      bytes += nested.bytes;
    } else {
      files += 1;
      bytes += info.size;
    }
  }
  return { files, bytes };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
