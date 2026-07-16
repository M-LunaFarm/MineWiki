import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('vote modals use the server eligibility contract and remain scrollable on small screens', async () => {
  const [hook, classic, modern] = await Promise.all([
    readFile(new URL('components/voting/use-vote-minecraft-identity.ts', root), 'utf8'),
    readFile(new URL('components/voting/vote-modal.tsx', root), 'utf8'),
    readFile(new URL('components/voting/vote-modal-modern.tsx', root), 'utf8'),
  ]);

  assert.match(hook, /\/v1\/servers\/\$\{serverId\}\/votes\/eligibility/);
  for (const source of [classic, modern]) {
    assert.match(source, /max-h-\[calc\(100dvh-2rem\)\]/);
    assert.match(source, /overflow-y-auto/);
    assert.match(source, /z-\[100\]/);
    assert.match(source, /createPortal/);
    assert.match(source, /eligibility\?\.eligible === false/);
    assert.match(source, /identityStatus === 'conflict'/);
    assert.doesNotMatch(source, /agreeTerms|agreePrivacy/);
  }
});
