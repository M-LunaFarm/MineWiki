#!/usr/bin/env node

import './load-environment.mjs';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseMysqlDatabaseUrl, resolveSafeDirectory } from './minewiki-backup-contract.mjs';

const snapshotArgument = process.argv.slice(2).find((argument) => argument !== '--');
const snapshot = resolveSafeDirectory(snapshotArgument, { label: 'snapshot path' });
const manifest = JSON.parse(await readFile(path.join(snapshot, 'manifest.json'), 'utf8'));
if (!manifest.verification?.verifiedAt) throw new Error('Restore drills require a verified backup manifest.');

const database = parseMysqlDatabaseUrl(process.env.DATABASE_URL);
const drillDatabase = `minewiki_restore_drill_${Date.now()}_${randomBytes(4).toString('hex')}`;
const mysqlArgs = ['--host', database.host, '--port', database.port, '--user', database.user, '--batch', '--skip-column-names'];
const env = { MYSQL_PWD: database.password };

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
  process.stdout.write(`Restore drill passed for ${manifest.snapshotId}: ${tableCount} tables, 4 critical tables.\n`);
} finally {
  await mysql([...mysqlArgs, '--execute', `DROP DATABASE IF EXISTS \`${drillDatabase}\``], env);
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
