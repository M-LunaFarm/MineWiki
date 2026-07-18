import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildAccountExportSections } from './account-export-sections';

test('account export selections never expose authentication, storage, or provider secrets', async () => {
  const source = (await Promise.all([
    readFile(new URL('./account-export-sections.ts', import.meta.url), 'utf8'),
    readFile(new URL('./account-export-wiki-sections.ts', import.meta.url), 'utf8'),
  ])).join('\n');
  const forbiddenSelections = [
    'passwordHash: true',
    'accessToken: true',
    'refreshToken: true',
    'secretCiphertext: true',
    'codeHash: true',
    'publicKey: true',
    'credentialId: true',
    'counter: true',
    'tokenVersion: true',
    'stepUpPurpose: true',
    'storagePath: true',
    'adminNote: true',
    'processedBy: true',
    'cancelledBy: true',
  ];
  for (const selection of forbiddenSelections) {
    assert.equal(source.includes(selection), false, `forbidden export selection: ${selection}`);
  }
  assert.match(source, /filterReadablePageIds/u);
  assert.match(source, /filteredPagedSection\('wikiRevisions'/u);
  assert.match(source, /filteredPagedSection\('wikiDiscussionComments'/u);
});

test('every export query has an explicit selection tree without secret field names', async () => {
  const calls: unknown[] = [];
  const delegate = new Proxy({}, {
    get: () => async (input: unknown) => { calls.push(input); return []; },
  });
  const prisma = new Proxy({}, { get: () => delegate });
  const sections = buildAccountExportSections(prisma as never, {
    canonicalAccountId: 'canonical', accountIds: ['canonical'], profileIds: [1n],
  }, async (ids) => new Set(ids), async (ids) => new Set(ids));
  for (const section of sections) await section.load(null);

  const selectedKeys = new Set<string>();
  for (const call of calls) collectSelectedKeys(call, selectedKeys);
  for (const key of [
    'passwordHash', 'accessToken', 'refreshToken', 'secretCiphertext', 'codeHash',
    'publicKey', 'credentialId', 'counter', 'token', 'tokenVersion', 'stepUpAt',
    'stepUpExpiresAt', 'stepUpMethod', 'stepUpPurpose', 'storagePath', 'adminNote',
    'processedBy', 'cancelledBy', 'cancelTokenHash', 'verificationCode',
    'serverSecret', 'publicKey', 'eventLog', 'verificationUrl', 'completionTokenHash',
  ]) assert.equal(selectedKeys.has(key), false, `forbidden selected field: ${key}`);
  assert.ok(calls.length >= 25, 'expected the complete export section set to be exercised');
});

function collectSelectedKeys(value: unknown, keys: Set<string>, insideSelect = false): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const selected = insideSelect || key === 'select';
    if (insideSelect && child === true) keys.add(key);
    collectSelectedKeys(child, keys, selected);
  }
}
