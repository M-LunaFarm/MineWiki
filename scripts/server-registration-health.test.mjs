import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production validation audits registration reservations and canonical claim ownership', async () => {
  const source = await readFile(new URL('./validate-data.mjs', import.meta.url), 'utf8');
  assert.match(source, /pending server registrations retain a bounded tenant reservation/u);
  assert.match(source, /registration_lease_expires_at IS NULL/u);
  assert.match(source, /verified server claims agree with canonical ownership/u);
  assert.match(source, /COALESCE\(claim_account\.canonicalAccountId, claim_account\.id\)/u);
  assert.match(source, /expired pending server registrations/u);
});
