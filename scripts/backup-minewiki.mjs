#!/usr/bin/env node

import './load-environment.mjs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseMysqlDatabaseUrl, resolveSafeDirectory } from './minewiki-backup-contract.mjs';

const options = parseArgs(process.argv.slice(2));
const database = parseMysqlDatabaseUrl(process.env.DATABASE_URL);
const uploadRoot = resolveSafeDirectory(process.env.UPLOAD_STORAGE_ROOT, { label: 'UPLOAD_STORAGE_ROOT' });
const backupRoot = resolveSafeDirectory(process.env.MINEWIKI_BACKUP_ROOT || '/var/backups/minewiki', {
  label: 'MINEWIKI_BACKUP_ROOT', forbidden: [uploadRoot],
});
const snapshotId = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
await mkdir(backupRoot, { recursive: true, mode: 0o700 });
const temporary = await mkdtemp(path.join(backupRoot, `.incomplete-${snapshotId}-`));
const destination = path.join(backupRoot, snapshotId);
const remote = process.env.MINEWIKI_BACKUP_REMOTE?.trim();
if (options.requireRemote && !remote) {
  await rm(temporary, { recursive: true, force: true });
  throw new Error('MINEWIKI_BACKUP_REMOTE is required by --require-remote.');
}
let verified = false;

try {
  const sqlPath = path.join(temporary, 'database.sql');
  const uploadsPath = path.join(temporary, 'uploads.tar.gz');
  await run('mysqldump', [
    '--single-transaction', '--quick', '--routines', '--triggers', '--events',
    '--host', database.host, '--port', database.port, '--user', database.user,
    '--result-file', sqlPath, database.database,
  ], { MYSQL_PWD: database.password });
  await run('tar', ['--create', '--gzip', '--file', uploadsPath, '--directory', uploadRoot, '.']);
  const [sql, uploads, uploadStats] = await Promise.all([
    artifact(sqlPath), artifact(uploadsPath), countFiles(uploadRoot),
  ]);
  if (sql.size === 0) throw new Error('mysqldump produced an empty database artifact.');
  const manifest = {
    schemaVersion: 1, snapshotId, createdAt: new Date().toISOString(),
    database: { engine: 'mysql', name: database.database, artifact: 'database.sql', ...sql },
    uploads: { artifact: 'uploads.tar.gz', source: uploadRoot, ...uploads, ...uploadStats },
    verification: null,
  };
  await writeFile(path.join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  await run(process.execPath, [path.resolve('scripts/verify-minewiki-backup.mjs'), destination]);
  verified = true;
  if (remote) await run('rclone', ['copy', destination, `${remote.replace(/\/$/u, '')}/${snapshotId}`]);
  process.stdout.write(`${snapshotId}\n`);
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  if (!verified && await exists(destination)) await rm(destination, { recursive: true, force: true });
  throw error;
}

function parseArgs(argv) {
  const unknown = argv.filter((arg) => arg !== '--require-remote');
  if (unknown.length) throw new Error(`Unknown backup option: ${unknown[0]}`);
  return { requireRemote: argv.includes('--require-remote') };
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...extraEnv } });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function artifact(file) {
  const content = await readFile(file); const info = await stat(file);
  return { size: info.size, sha256: createHash('sha256').update(content).digest('hex') };
}

async function countFiles(root) {
  let files = 0; let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) { const nested = await countFiles(target); files += nested.files; bytes += nested.bytes; }
    else if (entry.isFile()) { files += 1; bytes += (await stat(target)).size; }
  }
  return { files, sourceBytes: bytes };
}

async function exists(target) { try { await stat(target); return true; } catch { return false; } }
