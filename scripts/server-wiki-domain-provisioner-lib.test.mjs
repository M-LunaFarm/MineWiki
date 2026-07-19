import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  certificateNeedsRenewal,
  deriveProvisionerToken,
  normalizeProvisionedHostname,
  renderNginxConfiguration,
} from './server-wiki-domain-provisioner-lib.mjs';

test('normalizes only safe fully qualified hostnames', () => {
  assert.equal(normalizeProvisionedHostname('Docs.Example.COM.'), 'docs.example.com');
  for (const unsafe of ['', 'localhost', '-docs.example.com', 'docs.example.com/path', '*.example.com', '한글.example']) {
    assert.throws(() => normalizeProvisionedHostname(unsafe), /Unsafe custom hostname/u);
  }
});

test('derives a stable purpose-separated provisioner token', () => {
  assert.equal(
    deriveProvisionerToken('test-app-encryption-key-with-enough-entropy'),
    'AAI0Usizk9NenqKlXx6Tm2HZN65kaE0h2LQt5FaGrtY',
  );
  assert.throws(() => deriveProvisionerToken(''), /APP_ENCRYPTION_KEY/u);
});

test('renders exact HTTP challenge hosts and HTTPS only for ready certificates', () => {
  const rendered = renderNginxConfiguration({
    domains: [
      { hostname: 'ready.example.com', tlsReady: true },
      { hostname: 'pending.example.net', tlsReady: false },
    ],
    webroot: '/var/lib/letsencrypt',
    webUpstream: 'http://127.0.0.1:4320',
    apiUpstream: 'http://127.0.0.1:4321',
  });
  assert.match(rendered, /server_name ready\.example\.com;/u);
  assert.match(rendered, /server_name pending\.example\.net;/u);
  assert.match(rendered, /ssl_certificate \/etc\/letsencrypt\/live\/ready\.example\.com\/fullchain\.pem;/u);
  assert.doesNotMatch(rendered, /live\/pending\.example\.net\/fullchain/u);
  assert.match(rendered, /proxy_set_header Cookie "";/u);
  assert.match(rendered, /proxy_hide_header Set-Cookie;/u);
  assert.doesNotMatch(rendered, /server_name _;/u);
});

test('treats malformed certificates as requiring renewal', () => {
  assert.equal(certificateNeedsRenewal('not a certificate'), true);
});
