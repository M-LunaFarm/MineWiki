import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function manifest(relativePath) {
  return JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
}

test('production upload and request dependencies stay above audited security floors', async () => {
  const [root, api, security, web, worker] = await Promise.all([
    manifest('package.json'),
    manifest('apps/api/package.json'),
    manifest('packages/security/package.json'),
    manifest('apps/web/package.json'),
    manifest('apps/worker/package.json'),
  ]);

  assert.equal(root.pnpm.overrides['fast-uri@>=3.0.0 <3.1.4'], '3.1.4');
  assert.equal(root.pnpm.overrides['fast-uri@>=4.0.0 <4.1.1'], '4.1.1');
  assert.equal(root.pnpm.overrides['minimatch@3.1.5>brace-expansion'], '5.0.8');
  assert.equal(root.pnpm.overrides['minimatch@10.2.5>brace-expansion'], '5.0.8');
  assert.equal(root.pnpm.overrides['find-my-way@<9.7.0'], '9.7.0');
  assert.equal(root.pnpm.overrides['postcss@<8.5.18'], '8.5.18');
  assert.equal(root.pnpm.overrides['sharp@<0.35.0'], '0.35.3');
  assert.equal(api.dependencies.sharp, '^0.35.3');
  assert.equal(security.dependencies.sharp, '^0.35.3');
  assert.equal(api.dependencies['file-type'], '^21.3.1');
  assert.equal(security.dependencies['file-type'], '^21.3.1');
  assert.equal(api.dependencies.cookie, '^0.7.2');
  assert.equal(web.dependencies.next, '^15.5.21');
  assert.equal(web.dependencies.postcss, '^8.5.18');
  assert.equal(web.devDependencies['eslint-config-next'], '^15.5.21');
  assert.equal(api.dependencies['@sentry/node'], '^10.67.0');
  assert.equal(worker.dependencies['@sentry/node'], '^10.67.0');
  assert.equal(root.devDependencies.turbo, '^2.9.14');
});
