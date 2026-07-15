import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('frontend administration gates never treat authentication elevation as authority', async () => {
  const files = [
    new URL('../components/admin/admin-access-gate.tsx', import.meta.url),
    new URL('../components/layout/site-header.tsx', import.meta.url),
  ];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /isElevated/);
  }
});
