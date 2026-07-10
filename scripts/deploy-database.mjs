#!/usr/bin/env node

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
