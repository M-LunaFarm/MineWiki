const { test } = require('node:test');
const assert = require('node:assert/strict');
const schemas = require('@minewiki/schemas');

test('compiled shared contracts expose the public server lifecycle value', () => {
  assert.equal(schemas.PUBLIC_SERVER_LISTING_STATUS, 'active');
});
