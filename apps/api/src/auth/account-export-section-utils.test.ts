import assert from 'node:assert/strict';
import test from 'node:test';
import { filteredPagedSection } from './account-export-section-utils';

test('ACL-filtered pagination advances across a fully hidden database page', async () => {
  const calls: Array<string | null> = [];
  const section = filteredPagedSection('wikiRows', async (after) => {
    calls.push(after);
    if (after === null) return [{ id: 1n, visible: false }, { id: 2n, visible: false }];
    if (after === '2') return [{ id: 3n, visible: true }];
    return [];
  }, async (rows) => rows.filter((row) => row.visible));
  const rows = await section.load(null);
  assert.deepEqual(rows, [{ id: 3n, visible: true }]);
  assert.equal(section.cursor(rows[0]!), '3');
  assert.deepEqual(calls, [null, '2']);
});

test('ACL-filtered pagination stores the raw page cursor without serializing it', async () => {
  const section = filteredPagedSection('wikiRows', async () => [
    { id: 1n, visible: true }, { id: 2n, visible: false },
  ], async (rows) => rows.filter((row) => row.visible));
  const rows = await section.load(null);
  assert.equal(section.cursor(rows[0]!), '2');
  assert.equal(JSON.stringify(rows, (_key, value) => typeof value === 'bigint' ? String(value) : value), '[{"id":"1","visible":true}]');
});
