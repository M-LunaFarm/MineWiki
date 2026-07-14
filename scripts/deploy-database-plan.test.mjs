import assert from 'node:assert/strict';
import test from 'node:test';
import { planDatabaseDeployment } from './deploy-database-plan.mjs';

test('bootstraps only a completely empty database', () => {
  assert.deepEqual(planDatabaseDeployment([]), {
    kind: 'bootstrap',
    applicationTableCount: 0,
  });
});

test('migrates an existing database with Prisma history', () => {
  assert.deepEqual(planDatabaseDeployment(['Account', 'Server', '_prisma_migrations']), {
    kind: 'migrate',
    applicationTableCount: 2,
  });
});

test('fails closed for a non-empty legacy database without migration history', () => {
  assert.throws(
    () => planDatabaseDeployment(['Account', 'Server', 'Session']),
    /Refusing to modify a non-empty database without Prisma migration history/,
  );
});

test('fails closed for orphaned migration history without application tables', () => {
  assert.throws(
    () => planDatabaseDeployment(['_prisma_migrations']),
    /Refusing to bootstrap a database that has Prisma migration history but no application tables/,
  );
});
