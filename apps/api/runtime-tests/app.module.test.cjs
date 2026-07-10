const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/apps/api/src/app.module.js');

test('compiled application module resolves all runtime dependencies', async () => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    assert.ok(app.get(AppModule));
  } finally {
    await app.close();
  }
});
