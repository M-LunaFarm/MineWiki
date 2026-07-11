import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApiTargetUrl } from '../lib/api-proxy-target.mjs';

test('proxies the public health endpoint to the canonical API health route', () => {
  const target = buildApiTargetUrl('http://127.0.0.1:3000', ['health']);

  assert.equal(target.href, 'http://127.0.0.1:3000/health');
});

test('preserves a configured base path, query string, and encoded segments', () => {
  const target = buildApiTargetUrl(
    'https://api.example.test/internal/',
    ['v1', 'wiki pages'],
    '?locale=ko',
  );

  assert.equal(target.href, 'https://api.example.test/internal/v1/wiki%20pages?locale=ko');
});
