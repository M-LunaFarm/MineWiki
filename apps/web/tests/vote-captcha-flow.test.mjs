import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('web builds load production environment and guard embedded captcha keys', async () => {
  const [packageJson, buildScript, releaseScript] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../../../scripts/build-web.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../../scripts/prepare-web-release.mjs', import.meta.url), 'utf8'),
  ]);

  assert.match(packageJson, /node \.\.\/\.\.\/scripts\/build-web\.mjs/u);
  assert.match(buildScript, /load-environment\.mjs/u);
  assert.match(buildScript, /assertCaptchaPublicKeysEmbedded/u);
  assert.match(releaseScript, /assertCaptchaPublicKeysEmbedded/u);
});

test('vote clients omit an absent captcha token instead of sending null', async () => {
  const clients = await Promise.all([
    readFile(new URL('../components/voting/vote-modal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/voting/vote-modal-modern.tsx', import.meta.url), 'utf8'),
  ]);

  for (const client of clients) {
    assert.match(client, /\.\.\.\(captchaToken \? \{ captchaToken \} : \{\}\)/u);
    assert.doesNotMatch(client, /\n\s+captchaToken,\n/u);
  }
});

test('vote CAPTCHA widgets follow the active document theme', async () => {
  const sources = await Promise.all([
    readFile(new URL('../components/voting/vote-modal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/voting/vote-modal-modern.tsx', import.meta.url), 'utf8'),
  ]);

  for (const source of sources) {
    assert.match(source, /document\.documentElement\.dataset\.theme === 'light'/u);
    assert.match(source, /theme=\{captchaTheme\}/u);
    assert.doesNotMatch(source, /theme="dark"/u);
  }
});
