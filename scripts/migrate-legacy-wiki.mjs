#!/usr/bin/env node

import './load-environment.mjs';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { parse as parseDotenv } from 'dotenv';

const require = createRequire(import.meta.url);
const mysql = require('/var/www/mwiki/node_modules/mysql2/promise');
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}
if (!process.env.DATABASE_URL?.trim()) {
  console.error('DATABASE_URL is required for the integrated MineWiki target.');
  process.exit(1);
}

const sourceEnv = parseDotenv(await readFile(args.sourceEnv, 'utf8'));
const sourceConfig = {
  host: sourceEnv.DB_HOST || '127.0.0.1',
  port: Number(sourceEnv.DB_PORT || 3306),
  user: sourceEnv.DB_USER,
  password: sourceEnv.DB_PASSWORD,
  database: sourceEnv.DB_NAME,
};
const targetUrl = new URL(process.env.DATABASE_URL);
const targetConfig = {
  host: targetUrl.hostname,
  port: Number(targetUrl.port || 3306),
  user: decodeURIComponent(targetUrl.username),
  password: decodeURIComponent(targetUrl.password),
  database: targetUrl.pathname.slice(1),
};

if (!sourceConfig.user || !sourceConfig.database) {
  console.error('Legacy source environment is missing DB_USER or DB_NAME.');
  process.exit(1);
}
if (
  sourceConfig.host === targetConfig.host &&
  sourceConfig.port === targetConfig.port &&
  sourceConfig.database === targetConfig.database
) {
  console.error('Legacy source and integrated target must be different databases.');
  process.exit(1);
}

const tables = [
  'users',
  'namespaces',
  'wiki_spaces',
  'pages',
  'page_revisions',
  'recent_changes',
  'server_wikis',
  'mod_wikis',
  'subwiki_roles',
  'acl_groups',
  'acl_group_members',
  'acl_rules',
  'acl_change_logs',
  'groups',
  'user_groups',
  'group_permissions',
  'page_section_locks',
  'document_templates',
];
const deleteOrder = [...tables].reverse();
const source = await mysql.createConnection(sourceConfig);
const target = await mysql.createConnection(targetConfig);

try {
  await validateSchemas(source, target);
  const sourceCounts = await countTables(source);
  const targetCounts = await countTables(target);
  const marker = await migrationMarker(target);

  console.log(
    `Legacy wiki migration (${args.apply ? 'apply' : 'dry-run'}): ` +
      `${sourceCounts.pages} pages, ${sourceCounts.page_revisions} revisions, ` +
      `${sourceCounts.wiki_spaces} spaces, ${sourceCounts.users} users`,
  );
  console.log(
    `Current integrated wiki: ${targetCounts.pages} pages, ` +
      `${targetCounts.page_revisions} revisions, ${targetCounts.wiki_spaces} spaces`,
  );

  if (!args.apply) {
    console.log('No data changed. Rerun with --apply after taking a target database backup.');
    process.exit(0);
  }
  if (marker && !args.force) {
    throw new Error(
      `Legacy wiki was already imported at ${marker}; use --force only for an intentional full replacement.`,
    );
  }

  await validateExternalReferences(source, target);
  await target.beginTransaction();
  try {
    await target.query('SET FOREIGN_KEY_CHECKS=0');
    for (const table of deleteOrder) {
      await target.query(`DELETE FROM \`${table}\``);
    }
    for (const table of tables) {
      const copied = await copyTable(source, target, table, args.batchSize);
      console.log(`copied ${table}: ${copied}`);
    }
    await target.query('SET FOREIGN_KEY_CHECKS=1');
    await validateImportedGraph(target, sourceCounts);
    await writeMigrationMarker(target);
    await target.commit();
  } catch (error) {
    await target.rollback();
    await target.query('SET FOREIGN_KEY_CHECKS=1').catch(() => undefined);
    throw error;
  }

  console.log('Legacy wiki content import complete. Run pnpm data:validate -- --fix next.');
} catch (error) {
  console.error(`Legacy wiki migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await source.end();
  await target.end();
}

async function validateSchemas(sourceDb, targetDb) {
  for (const table of tables) {
    const [sourceColumns] = await sourceDb.query(`SHOW COLUMNS FROM \`${table}\``);
    const [targetColumns] = await targetDb.query(`SHOW COLUMNS FROM \`${table}\``);
    const targetNames = new Set(targetColumns.map((column) => column.Field));
    const missing = sourceColumns
      .map((column) => column.Field)
      .filter((column) => !targetNames.has(column));
    if (missing.length > 0) {
      throw new Error(`Target table ${table} is missing source columns: ${missing.join(', ')}`);
    }
  }
}

async function countTables(db) {
  const [[row]] = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM pages) AS pages,
      (SELECT COUNT(*) FROM page_revisions) AS page_revisions,
      (SELECT COUNT(*) FROM wiki_spaces) AS wiki_spaces,
      (SELECT COUNT(*) FROM users) AS users
  `);
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

async function migrationMarker(db) {
  const [rows] = await db.query(
    "SELECT value FROM site_settings WHERE `key`='migration.legacyWikiImportedAt' LIMIT 1",
  );
  if (!rows[0]?.value) {
    return null;
  }
  const raw = String(rows[0].value);
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : raw;
  } catch {
    return raw;
  }
}

async function writeMigrationMarker(db) {
  await db.query(
    `INSERT INTO site_settings (\`key\`, value, description, created_at, updated_at)
     VALUES ('migration.legacyWikiImportedAt', ?, 'Legacy mwiki content import marker', NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=NOW(3)`,
    [JSON.stringify(new Date().toISOString())],
  );
}

async function validateExternalReferences(sourceDb, targetDb) {
  const linkedUsers = (await hasColumn(sourceDb, 'users', 'account_id'))
    ? (await sourceDb.query('SELECT DISTINCT account_id FROM users WHERE account_id IS NOT NULL'))[0]
    : [];
  if (linkedUsers.length > 0) {
    const ids = linkedUsers.map((row) => row.account_id);
    const [accounts] = await targetDb.query('SELECT id FROM Account WHERE id IN (?)', [ids]);
    if (accounts.length !== ids.length) {
      throw new Error('Some legacy wiki users reference accounts missing from the integrated database.');
    }
  }

  const linkedServers = (await hasColumn(sourceDb, 'server_wikis', 'vote_server_id'))
    ? (await sourceDb.query(
        'SELECT DISTINCT vote_server_id FROM server_wikis WHERE vote_server_id IS NOT NULL',
      ))[0]
    : [];
  if (linkedServers.length > 0) {
    const ids = linkedServers.map((row) => row.vote_server_id);
    const [servers] = await targetDb.query('SELECT id FROM Server WHERE id IN (?)', [ids]);
    if (servers.length !== ids.length) {
      throw new Error('Some legacy server wikis reference servers missing from the integrated database.');
    }
  }
}

async function hasColumn(db, table, column) {
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
  return rows.length > 0;
}

async function copyTable(sourceDb, targetDb, table, batchSize) {
  const [sourceColumns] = await sourceDb.query(`SHOW COLUMNS FROM \`${table}\``);
  const [targetColumns] = await targetDb.query(`SHOW COLUMNS FROM \`${table}\``);
  const targetNames = new Set(targetColumns.map((column) => column.Field));
  const columns = sourceColumns.map((column) => column.Field).filter((column) => targetNames.has(column));
  const quotedColumns = columns.map((column) => `\`${column}\``).join(', ');
  let offset = 0;
  let copied = 0;

  while (true) {
    const [rows] = await sourceDb.query(
      `SELECT ${quotedColumns} FROM \`${table}\` LIMIT ? OFFSET ?`,
      [batchSize, offset],
    );
    if (rows.length === 0) {
      return copied;
    }
    const placeholders = rows
      .map(() => `(${columns.map(() => '?').join(', ')})`)
      .join(', ');
    const values = rows.flatMap((row) => columns.map((column) => row[column]));
    await targetDb.query(
      `INSERT INTO \`${table}\` (${quotedColumns}) VALUES ${placeholders}`,
      values,
    );
    copied += rows.length;
    offset += rows.length;
  }
}

async function validateImportedGraph(db, expected) {
  const actual = await countTables(db);
  for (const key of ['pages', 'page_revisions', 'wiki_spaces', 'users']) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Imported ${key} count mismatch: expected ${expected[key]}, got ${actual[key]}`);
    }
  }
  const checks = [
    ['page namespace', 'SELECT p.id FROM pages p LEFT JOIN namespaces n ON n.id=p.namespace_id WHERE n.id IS NULL LIMIT 1'],
    ['page space', 'SELECT p.id FROM pages p LEFT JOIN wiki_spaces s ON s.id=p.space_id WHERE s.id IS NULL LIMIT 1'],
    ['revision page', 'SELECT r.id FROM page_revisions r LEFT JOIN pages p ON p.id=r.page_id WHERE p.id IS NULL LIMIT 1'],
    ['current revision', 'SELECT p.id FROM pages p LEFT JOIN page_revisions r ON r.id=p.current_revision_id WHERE p.current_revision_id IS NOT NULL AND r.id IS NULL LIMIT 1'],
  ];
  for (const [label, sql] of checks) {
    const [rows] = await db.query(sql);
    if (rows.length > 0) {
      throw new Error(`Imported graph contains a dangling ${label} reference.`);
    }
  }
}

function parseArgs(argv) {
  const parsed = {
    sourceEnv: '/var/www/mwiki/.env',
    batchSize: 100,
    apply: false,
    force: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--apply') parsed.apply = true;
    else if (arg === '--force') parsed.force = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg.startsWith('--source-env=')) parsed.sourceEnv = arg.slice('--source-env='.length);
    else if (arg.startsWith('--batch-size=')) {
      const value = Number(arg.slice('--batch-size='.length));
      if (Number.isInteger(value) && value > 0 && value <= 1000) parsed.batchSize = value;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: pnpm data:migrate-wiki [--apply] [--force]

Copies the legacy mwiki users, spaces, pages, full revision history, recent
changes, ACLs, groups, templates, and server/mod wiki metadata into the
integrated MineWiki database. The default mode is read-only.

Options:
  --apply                  Replace the integrated wiki subset with legacy data
  --force                  Repeat an already completed full replacement
  --source-env=/path/.env  Legacy mwiki environment file
  --batch-size=100         Rows copied per insert batch`);
}
