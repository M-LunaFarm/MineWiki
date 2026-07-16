'use strict';

const DATABASE_TEST_OPT_IN = 'MINEWIKI_ALLOW_DB_TESTS';

function configureDatabaseTestEnvironment(environment = process.env) {
  environment.NODE_ENV = 'test';

  if (environment[DATABASE_TEST_OPT_IN] !== '1') {
    // Keep the key present so dotenv cannot hydrate a production URL later.
    environment.DATABASE_URL = '';
    environment.MINEWIKI_ENV_FILE = '';
    return;
  }

  const rawUrl = environment.DATABASE_URL?.trim();
  if (!rawUrl) {
    throw new Error(`${DATABASE_TEST_OPT_IN}=1 requires DATABASE_URL.`);
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(new URL(rawUrl).pathname.replace(/^\//u, ''));
  } catch {
    throw new Error('Database integration tests require a valid DATABASE_URL.');
  }

  if (!/(?:^|[_-])test(?:[_-]|$)/iu.test(databaseName)) {
    throw new Error(
      `Refusing to run database integration tests against non-test database ${JSON.stringify(databaseName)}.`,
    );
  }
}

configureDatabaseTestEnvironment();

module.exports = { configureDatabaseTestEnvironment };
