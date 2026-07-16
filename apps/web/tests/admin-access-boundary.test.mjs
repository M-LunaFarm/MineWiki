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

test('wiki administration routes and navigation use their exact delegated permissions', async () => {
  const gate = await readFile(
    new URL('../components/admin/admin-access-gate.tsx', import.meta.url),
    'utf8',
  );
  const consoleSource = await readFile(
    new URL('../components/wiki/wiki-admin-console.tsx', import.meta.url),
    'utf8',
  );
  const seed = await readFile(new URL('../../../scripts/seed.mjs', import.meta.url), 'utf8');

  for (const [path, permission] of [
    ['/admin/wiki/users', 'wiki.user.block'],
    ['/admin/wiki/batch-rollback', 'wiki.batch_rollback'],
    ['/admin/wiki/reports', 'wiki.report.moderate'],
    ['/admin/wiki/acl', 'wiki.acl.manage'],
  ]) {
    assert.match(gate, new RegExp(`pathname\\.startsWith\\('${path}'\\)[^\\n]+permissions\\.includes\\('${permission}'\\)`));
    assert.match(consoleSource, new RegExp(`can\\('${permission}'\\)`));
  }

  assert.match(seed, /wiki_admin: \[[^\]]*'wiki\.user\.block'[^\]]*'wiki\.batch_rollback'/);
  assert.match(seed, /moderator: \[[^\]]*'wiki\.user\.block'[^\]]*'wiki\.batch_rollback'/);
});
