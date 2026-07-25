import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { API_JSON_BODY_LIMIT_BYTES, MAX_IMAGE_UPLOAD_BYTES } from './body-limits';

test('JSON body limit accepts a maximum-size base64 image without opening an unbounded parser', () => {
  const base64Length = Math.ceil(MAX_IMAGE_UPLOAD_BYTES / 3) * 4;
  const dataUrlAndJsonOverhead = Buffer.byteLength(
    JSON.stringify({ data: `data:image/webp;base64,${'a'.repeat(base64Length)}` }),
  );

  assert.ok(API_JSON_BODY_LIMIT_BYTES > dataUrlAndJsonOverhead);
  assert.ok(API_JSON_BODY_LIMIT_BYTES < 4 * 1024 * 1024);
});

test('Fastify uses the bounded JSON parser limit at application startup', async () => {
  const main = await readFile(new URL('../../main.ts', import.meta.url), 'utf8');

  assert.match(main, /bodyLimit:\s*API_JSON_BODY_LIMIT_BYTES/u);
});
