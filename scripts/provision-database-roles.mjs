#!/usr/bin/env node

import './load-environment.mjs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'dotenv';
import { parseMysqlDatabaseUrl } from './minewiki-backup-contract.mjs';

if (!process.argv.includes('--apply')) {
  throw new Error('Refusing to change database roles without --apply.');
}

const envFile = path.resolve(process.env.MINEWIKI_ENV_FILE?.trim() || '.env');
const source = await readFile(envFile, 'utf8');
const fileEnv = parse(source);
const adminUrl = process.env.MINEWIKI_DATABASE_ADMIN_URL?.trim() || fileEnv.DATABASE_URL;
const admin = parseMysqlDatabaseUrl(adminUrl);
const databaseName = quoteIdentifier(admin.database);
const accounts = {
  DATABASE_URL: { user: 'minewiki_app', grants: `SELECT, INSERT, UPDATE, DELETE ON ${databaseName}.*` },
  MINEWIKI_MIGRATION_DATABASE_URL: { user: 'minewiki_migrator', grants: `ALL PRIVILEGES ON ${databaseName}.*` },
  MINEWIKI_BACKUP_DATABASE_URL: { user: 'minewiki_backup', grants: `SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES ON ${databaseName}.*` },
  MINEWIKI_DRILL_DATABASE_URL: {
    user: 'minewiki_drill',
    grants: 'ALL PRIVILEGES ON `minewiki\\_restore\\_drill\\_%`.*',
  },
};

const statements = [];
const credentials = {};
for (const [key, account] of Object.entries(accounts)) {
  const password = randomBytes(32).toString('base64url');
  credentials[key] = { ...account, password };
  statements.push(
    `DROP USER IF EXISTS '${account.user}'@'localhost'`,
    `CREATE USER '${account.user}'@'localhost' IDENTIFIED BY '${password}'`,
    `GRANT ${account.grants} TO '${account.user}'@'localhost'`,
  );
}
statements.push('FLUSH PRIVILEGES');
runMysql(admin, `${statements.join('; ')};`);

const environmentUpdates = {};
for (const [key, credential] of Object.entries(credentials)) {
  const value = new URL(adminUrl);
  value.username = credential.user;
  value.password = credential.password;
  value.hostname = admin.host === 'localhost' ? '127.0.0.1' : admin.host;
  value.port = admin.port;
  environmentUpdates[key] = value.toString();
}

const temporary = `${envFile}.roles-${process.pid}`;
await writeFile(temporary, updateEnvironment(source, environmentUpdates), { mode: 0o600 });
await chmod(temporary, 0o600);
await rename(temporary, envFile);
process.stdout.write(`Provisioned isolated database roles for ${admin.database}.\n`);

function runMysql(connection, sql) {
  const result = spawnSync('mysql', [
    '--host', connection.host,
    '--port', connection.port,
    '--user', connection.user,
    '--execute', sql,
  ], {
    env: { ...process.env, MYSQL_PWD: connection.password },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`mysql exited with status ${result.status ?? 'unknown'}`);
}

function quoteIdentifier(value) {
  return `\`${String(value).replaceAll('`', '``')}\``;
}

function updateEnvironment(sourceText, values) {
  const pending = new Map(Object.entries(values));
  const lines = sourceText.split(/\r?\n/u).map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/u);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}
