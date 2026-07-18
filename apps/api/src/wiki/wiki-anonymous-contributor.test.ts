import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearWikiAnonymousContributorCookie,
  createWikiAnonymousContributorToken,
  readWikiAnonymousContributorToken,
  serializeWikiAnonymousContributorCookie,
  wikiAnonymousContributorDigest,
} from './wiki-anonymous-contributor';

test('anonymous contributor tokens are high entropy capabilities stored only as digests', () => {
  const first = createWikiAnonymousContributorToken();
  const second = createWikiAnonymousContributorToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(first, second);
  assert.match(wikiAnonymousContributorDigest(first) ?? '', /^[a-f0-9]{64}$/u);
  assert.notEqual(wikiAnonymousContributorDigest(first), wikiAnonymousContributorDigest(second));
  assert.equal(wikiAnonymousContributorDigest('invalid'), null);
});

test('anonymous contributor cookie is host-only, secure, http-only and same-site', () => {
  const token = createWikiAnonymousContributorToken();
  const cookie = serializeWikiAnonymousContributorCookie(token);
  assert.match(cookie, /^__Host-mw_wiki_contributor=/u);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.match(cookie, /SameSite=Lax/u);
  assert.match(cookie, /Path=\//u);
  assert.doesNotMatch(cookie, /Domain=/u);
  assert.equal(readWikiAnonymousContributorToken(cookie), token);
  assert.match(clearWikiAnonymousContributorCookie(), /Max-Age=0/u);
});
