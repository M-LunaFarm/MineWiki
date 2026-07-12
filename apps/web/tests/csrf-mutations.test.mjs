import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mutationFiles = [
  'app/servers/register/page.tsx',
  'app/minecraft/callback/callback-client.tsx',
  'components/claim/claim-workflow.tsx',
  'components/minecraft/ownership-panel.tsx',
  'components/reviews/review-composer.tsx',
  'components/reviews/review-list.tsx',
  'components/servers/server-description-editor.tsx',
  'components/servers/server-owner-controls.tsx',
  'components/voting/vote-modal.tsx',
  'components/voting/vote-modal-modern.tsx',
  'lib/dashboard-api.ts',
  'lib/support-api.ts',
];

test('authenticated browser mutations attach CSRF headers', () => {
  for (const relativePath of mutationFiles) {
    const source = readFileSync(resolve(import.meta.dirname, '..', relativePath), 'utf8');
    const mutationCount = [...source.matchAll(/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/g)].length;
    const csrfCount = [...source.matchAll(/await csrfHeaders\(\)/g)].length;
    assert.ok(mutationCount > 0, `${relativePath} should contain a mutation request`);
    assert.equal(
      csrfCount,
      mutationCount,
      `${relativePath} must attach CSRF headers to every mutation request`,
    );
  }
});
