#!/usr/bin/env node

import './load-environment.mjs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const prismaCli = require.resolve('prisma/build/index.js');
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(rootDir, 'prisma', 'migrations');

if (!process.env.DATABASE_URL?.trim()) {
  console.error('DATABASE_URL is required to deploy the database.');
  process.exit(1);
}

const prisma = new PrismaClient();

try {
  const tables = await listTables(prisma);
  const applicationTables = tables.filter((table) => table !== '_prisma_migrations');

  if (applicationTables.length === 0) {
    console.log('Empty database detected; creating the current MineWiki schema.');
    if (tables.includes('_prisma_migrations')) {
      await prisma.$executeRawUnsafe('DROP TABLE `_prisma_migrations`');
    }
    await prisma.$disconnect();

    runPrisma(['db', 'push', '--skip-generate']);
    for (const migration of await listMigrations()) {
      runPrisma(['migrate', 'resolve', '--applied', migration]);
    }
    runPrisma(['migrate', 'deploy']);
    console.log('Fresh MineWiki database bootstrap complete.');
  } else if (!tables.includes('_prisma_migrations')) {
    console.log(
      `Legacy database without Prisma migration history detected (${applicationTables.length} application tables).`,
    );
    await assertLegacyBaselineIsSafe(prisma, applicationTables);
    await prisma.$disconnect();

    runPrisma(['db', 'push', '--accept-data-loss', '--skip-generate']);
    await applyLegacyBackfills(prisma);
    await prisma.$disconnect();

    for (const migration of await listMigrations()) {
      runPrisma(['migrate', 'resolve', '--applied', migration]);
    }
    runPrisma(['migrate', 'deploy']);
    console.log('Legacy MineWiki database baseline complete.');
  } else {
    console.log(`Existing database detected (${applicationTables.length} application tables).`);
    await prisma.$disconnect();
    runPrisma(['migrate', 'deploy']);
  }
} catch (error) {
  await prisma.$disconnect().catch(() => undefined);
  console.error(`Database deployment failed: ${formatError(error)}`);
  process.exitCode = 1;
}

async function assertLegacyBaselineIsSafe(client, tables) {
  const tableSet = new Set(tables.map((table) => table.toLowerCase()));
  for (const table of ['Server', 'Account', 'Session']) {
    if (!tableSet.has(table.toLowerCase())) {
      throw new Error(`Legacy baseline requires the ${table} table.`);
    }
  }

  await assertNoRows(
    client,
    'duplicate Minecraft ownership UUIDs',
    `
      SELECT uuid
      FROM MinecraftIdentity
      WHERE uuid IS NOT NULL AND TRIM(uuid) <> ''
      GROUP BY uuid
      HAVING COUNT(*) > 1
      LIMIT 1
    `,
    tableSet.has('minecraftidentity'),
  );
  await assertNoRows(
    client,
    'invalid Server JSON fields',
    `
      SELECT id
      FROM Server
      WHERE JSON_VALID(supportedVersions) = 0 OR JSON_VALID(tags) = 0
      LIMIT 1
    `,
  );
  await assertNoRows(
    client,
    'invalid ServerReview tags JSON',
    'SELECT id FROM ServerReview WHERE JSON_VALID(tags) = 0 LIMIT 1',
    tableSet.has('serverreview'),
  );
  await assertNoRows(
    client,
    'invalid ServerStats sparkline JSON',
    'SELECT serverId FROM ServerStats WHERE JSON_VALID(sparkline) = 0 LIMIT 1',
    tableSet.has('serverstats'),
  );
  console.log('Legacy baseline safety checks passed.');
}

async function assertNoRows(client, label, sql, enabled = true) {
  if (!enabled) {
    return;
  }
  const rows = await client.$queryRawUnsafe(sql);
  if (rows.length > 0) {
    throw new Error(`Cannot baseline database: ${label} must be resolved first.`);
  }
}

async function applyLegacyBackfills(client) {
  await client.$executeRawUnsafe(
    'UPDATE `Session` SET `isElevated` = FALSE WHERE `isElevated` = TRUE',
  );
  await client.$executeRawUnsafe(`
    UPDATE Server AS server
    JOIN (
      SELECT
        grouped.keepId,
        SHA2(CONCAT(grouped.editionKey, ':', grouped.hostKey, ':', grouped.portKey), 256) AS endpointKey
      FROM (
        SELECT
          MIN(id) AS keepId,
          CAST(edition AS CHAR) AS editionKey,
          LOWER(TRIM(TRAILING '.' FROM TRIM(joinHost))) AS hostKey,
          joinPort AS portKey
        FROM Server
        GROUP BY edition, LOWER(TRIM(TRAILING '.' FROM TRIM(joinHost))), joinPort
      ) AS grouped
    ) AS canonical ON canonical.keepId = server.id
    SET server.registrationEndpointKey = canonical.endpointKey
    WHERE server.registrationEndpointKey IS NULL
  `);
  await client.$executeRawUnsafe(`
    INSERT IGNORE INTO plugin_servers (
      id,
      minewiki_server_id,
      guild_id,
      plugin_server_id,
      server_name,
      host,
      port,
      endpoint_url,
      server_secret,
      enabled,
      created_at,
      updated_at,
      last_seen_at
    )
    SELECT
      UUID(),
      NULL,
      guild_id,
      server_id,
      server_name,
      server_host,
      server_port,
      endpoint_url,
      server_secret,
      enabled,
      created_at,
      updated_at,
      last_seen_at
    FROM guild_servers
  `);
  console.log('Legacy identity, endpoint, and plugin backfills complete.');
}

async function listTables(client) {
  const rows = await client.$queryRawUnsafe('SHOW TABLES');
  return rows
    .map((row) => Object.values(row)[0])
    .filter((value) => typeof value === 'string');
}

async function listMigrations() {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function runPrisma(args) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`prisma ${args.join(' ')} exited with status ${result.status ?? 'unknown'}`);
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
