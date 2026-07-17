import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLegacyRedirect } from '../lib/legacy-redirects.mjs';

function redirectFor(path) {
  return resolveLegacyRedirect(new URL(path, 'https://minewiki.test'));
}

test('/wiki redirects to the seeded main page', () => {
  assert.deepEqual(redirectFor('/wiki'), {
    destination: '/wiki/대문',
    status: 301
  });
});

test('/server/* remains available for application-level server wiki redirects', () => {
  assert.equal(redirectFor('/server/example'), null);
});

test('namespace roots and the legacy mods route resolve to seeded front pages', () => {
  for (const [source, destination] of [
    ['/mods', '/mod/대문'],
    ['/mod', '/mod/대문'],
    ['/dev', '/dev/대문'],
    ['/guide', '/guide/대문'],
    ['/data', '/data/대문'],
    ['/help', '/help/대문'],
    ['/project', '/project/대문'],
    ['/template', '/template/대문'],
    ['/file', '/file/대문'],
  ]) {
    assert.deepEqual(redirectFor(source), { destination, status: 301 });
  }
});

test('legacy Korean wiki namespace paths redirect to canonical server wiki paths', () => {
  assert.deepEqual(redirectFor('/wiki/서버/example/규칙?redirect=0'), {
    destination: '/server/example/%EA%B7%9C%EC%B9%99?redirect=0',
    status: 301
  });
});

test('old verify URL redirects into the current Minecraft ownership flow', () => {
  assert.deepEqual(redirectFor('/verify/00000000-0000-4000-8000-000000000001'), {
    destination: '/me?verifySessionId=00000000-0000-4000-8000-000000000001',
    status: 302
  });
});

test('old Microsoft auth callback redirects to the current Minecraft callback', () => {
  assert.deepEqual(redirectFor('/auth/microsoft/callback?code=abc&state=xyz'), {
    destination: '/minecraft/callback?code=abc&state=xyz',
    status: 302
  });
});

test('old guild dashboard subpages redirect to the current guild detail page', () => {
  assert.deepEqual(redirectFor('/guilds/123/messages'), {
    destination: '/guilds/123',
    status: 302
  });
});

test('old file raw paths redirect to the file wiki page', () => {
  assert.deepEqual(redirectFor('/file/example.png/raw'), {
    destination: '/file/example.png',
    status: 301
  });
});
