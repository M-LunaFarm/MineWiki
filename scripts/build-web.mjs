import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCaptchaKeyPairs, assertCaptchaPublicKeysEmbedded } from './web-captcha-build-guard.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(repoRoot, 'apps/web');
process.chdir(repoRoot);
await import('./load-environment.mjs');

assertCaptchaKeyPairs();
const nextCli = path.join(webRoot, 'node_modules/next/dist/bin/next');
const result = spawnSync(process.execPath, [nextCli, 'build'], {
  cwd: webRoot,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

await assertCaptchaPublicKeysEmbedded(path.join(webRoot, '.next/static'));
