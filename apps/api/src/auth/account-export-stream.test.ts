import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountExportStream } from './account-export-stream';

test('account export stream emits valid versioned JSON and paginates without buffering the whole dataset', async () => {
  const calls: Array<string | null> = [];
  const stream = createAccountExportStream({
    generatedAt: new Date('2026-07-18T00:00:00.000Z'),
    canonicalAccountId: 'canonical',
    accountIds: ['canonical', 'linked'],
    profileIds: ['9'],
  }, [{
    name: 'wikiRevisions',
    async load(after) {
      calls.push(after);
      if (after === null) return [{ id: 1n, contentRaw: '첫 판' }, { id: 2n, contentRaw: '둘째 판' }];
      if (after === '2') return [{ id: 3n, contentRaw: '셋째 판' }];
      return [];
    },
    cursor: (row) => String(row.id),
  }]);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  assert.equal(parsed.format, 'minewiki-account-export');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.completed, true);
  assert.deepEqual(parsed.scope.accountIds, ['canonical', 'linked']);
  assert.deepEqual(parsed.data.wikiRevisions.map((row: { id: string }) => row.id), ['1', '2', '3']);
  assert.deepEqual(calls, [null, '2', '3']);
});

test('account export stream rejects a section whose cursor does not advance', async () => {
  const stream = createAccountExportStream({
    generatedAt: new Date(), canonicalAccountId: 'a', accountIds: ['a'], profileIds: [],
  }, [{ name: 'broken', async load(after) { return after ? [{ id: after }] : [{ id: 'same' }]; }, cursor: () => 'same' }]);
  await assert.rejects(async () => {
    stream.resume();
    await new Promise<void>((resolve, reject) => {
      stream.once('end', resolve);
      stream.once('error', reject);
    });
  }, /did not advance/u);
});
