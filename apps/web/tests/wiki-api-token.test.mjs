import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('Wiki API token browser client uses session and CSRF protected management routes', async () => {
  const source = await readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8');

  assert.match(source, /listWikiApiTokens[\s\S]*\/v1\/wiki\/api-tokens/u);
  assert.match(source, /listWikiApiTokenSpaces[\s\S]*\/v1\/wiki\/api-tokens\/spaces/u);
  assert.match(source, /createWikiApiToken[\s\S]*'POST'/u);
  assert.match(source, /revokeWikiApiToken[\s\S]*'DELETE'/u);
  assert.match(source, /mutateWikiBrowser[\s\S]*csrfHeaders/u);
});

test('one-time Wiki API secret stays in component memory and can be cleared', async () => {
  const source = await readFile(
    new URL('../components/account/wiki-api-token-panel.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /useState<WikiApiTokenCreated \| null>\(null\)/u);
  assert.match(source, /setCreatedToken\(null\)/u);
  assert.match(source, /이 값은 다시 표시되지 않습니다/u);
  assert.doesNotMatch(source, /localStorage|sessionStorage/u);
  assert.match(source, /GitHub Actions Secrets/u);
});

test('account security orders MFA before long-lived Wiki API credentials', async () => {
  const source = await readFile(new URL('../app/me/account-client.tsx', import.meta.url), 'utf8');
  const mfa = source.indexOf('<MfaSecurityPanel />');
  const tokens = source.indexOf('<WikiApiTokenPanel />');

  assert.ok(mfa >= 0);
  assert.ok(tokens > mfa);
});
