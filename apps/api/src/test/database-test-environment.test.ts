import assert from 'node:assert/strict';
import test from 'node:test';

// The preload must remain plain CommonJS so Node test workers can load it before tsx.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { configureDatabaseTestEnvironment } = require('./database-test-environment.cjs') as {
  configureDatabaseTestEnvironment(environment?: NodeJS.ProcessEnv): void;
};

test('database tests fail closed unless explicitly enabled', () => {
  const environment = {
    DATABASE_URL: 'mysql://user:secret@localhost:3306/production',
    MINEWIKI_ENV_FILE: '/srv/production.env',
  } as NodeJS.ProcessEnv;

  configureDatabaseTestEnvironment(environment);

  assert.equal(environment.NODE_ENV, 'test');
  assert.equal(environment.DATABASE_URL, '');
  assert.equal(environment.MINEWIKI_ENV_FILE, '');
});

test('database tests accept an explicitly enabled test database', () => {
  const environment = {
    MINEWIKI_ALLOW_DB_TESTS: '1',
    DATABASE_URL: 'mysql://user:secret@localhost:3306/minewiki_test',
  } as NodeJS.ProcessEnv;

  assert.doesNotThrow(() => configureDatabaseTestEnvironment(environment));
  assert.equal(environment.DATABASE_URL, 'mysql://user:secret@localhost:3306/minewiki_test');
});

test('database tests reject an explicitly enabled production database', () => {
  const environment = {
    MINEWIKI_ALLOW_DB_TESTS: '1',
    DATABASE_URL: 'mysql://user:secret@localhost:3306/creepervote',
  } as NodeJS.ProcessEnv;

  assert.throws(
    () => configureDatabaseTestEnvironment(environment),
    /Refusing to run database integration tests against non-test database/u,
  );
});
