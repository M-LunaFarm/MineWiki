import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const challenge = readFileSync(new URL('../components/security/captcha-challenge.tsx', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../components/wiki/wiki-editor-client.tsx', import.meta.url), 'utf8');
const discussion = readFileSync(new URL('../components/wiki/wiki-discussion-client.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const compose = readFileSync(new URL('../../../compose.yml', import.meta.url), 'utf8');

test('new wiki pages and discussions share the configured captcha challenge', () => {
  assert.match(challenge, /NEXT_PUBLIC_TURNSTILE_SITE_KEY/u);
  assert.match(challenge, /NEXT_PUBLIC_HCAPTCHA_SITE_KEY/u);
  assert.match(editor, /const needsCaptcha = !page && isCaptchaConfigured\(\)/u);
  assert.match(editor, /<CaptchaChallenge resetKey=\{captchaKey\}/u);
  assert.match(discussion, /<CaptchaChallenge resetKey=\{captchaKey\}/u);
  assert.match(api, /captchaToken: input\.captchaToken/u);
});

test('existing wiki edits and discussion comments do not require a new captcha', () => {
  assert.match(editor, /const needsCaptcha = !page/u);
  const start = api.indexOf('export async function addWikiThreadComment');
  const end = api.indexOf('export async function voteWikiDiscussionPoll', start);
  const commentFunction = start >= 0 && end > start ? api.slice(start, end) : '';
  assert.notEqual(commentFunction, '');
  assert.doesNotMatch(commentFunction, /captchaToken/u);
});

test('container builds receive the public captcha keys used by the client bundle', () => {
  assert.match(dockerfile, /ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY/u);
  assert.match(dockerfile, /ARG NEXT_PUBLIC_HCAPTCHA_SITE_KEY/u);
  assert.match(compose, /NEXT_PUBLIC_TURNSTILE_SITE_KEY: \$\{NEXT_PUBLIC_TURNSTILE_SITE_KEY:-\}/u);
  assert.match(compose, /NEXT_PUBLIC_HCAPTCHA_SITE_KEY: \$\{NEXT_PUBLIC_HCAPTCHA_SITE_KEY:-\}/u);
});
