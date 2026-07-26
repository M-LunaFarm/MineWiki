import assert from 'node:assert/strict';
import test from 'node:test';
import nextConfig from '../next.config.js';

test('all web routes carry the production security header baseline', async () => {
  assert.equal(nextConfig.poweredByHeader, false);

  const rules = await nextConfig.headers();
  const globalRule = rules.find((rule) => rule.source === '/:path*');
  const headers = Object.fromEntries(
    (globalRule?.headers ?? []).map((header) => [header.key.toLowerCase(), header.value]),
  );

  assert.equal(headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.match(headers['permissions-policy'], /camera=\(\)/u);
  assert.match(headers['permissions-policy'], /microphone=\(\)/u);
});

