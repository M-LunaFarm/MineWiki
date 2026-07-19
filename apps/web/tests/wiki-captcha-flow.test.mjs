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
  assert.match(editor, /const needsCaptcha = Boolean\(\(!page \|\| anonymousReviewEnabled\) && isCaptchaConfigured\(\)\)/u);
  assert.match(editor, /<CaptchaChallenge resetKey=\{captchaKey\}/u);
  assert.match(discussion, /<CaptchaChallenge resetKey=\{captchaKey\}/u);
  assert.match(api, /captchaToken: input\.captchaToken/u);
});

test('authenticated existing wiki edits and discussion comments do not require a new captcha', () => {
  assert.match(editor, /captchaToken: anonymousReviewEnabled \? captchaToken/u);
  assert.match(editor, /const anonymousReviewEnabled = Boolean\([\s\S]*!account[\s\S]*&& page/u);
  const start = api.indexOf('export async function addWikiThreadComment');
  const end = api.indexOf('export async function voteWikiDiscussionPoll', start);
  const commentFunction = start >= 0 && end > start ? api.slice(start, end) : '';
  assert.notEqual(commentFunction, '');
  assert.match(commentFunction, /captchaToken\?: string/u);
  assert.match(discussion, /captchaToken: !account \? replyCaptchaToken/u);
  assert.match(discussion, /!account && needsCaptcha \? <CaptchaChallenge resetKey=\{replyCaptchaKey\}/u);
});

test('guest discussion forms follow API capabilities and keep member-only poll features hidden', () => {
  assert.match(discussion, /\{canCreateThread \? \(/u);
  assert.match(discussion, /\{account \? <PollComposer enabled=\{createPollEnabled\}/u);
  assert.match(discussion, /poll: account && replyPollEnabled/u);
  assert.match(discussion, /익명 토론은 이 브라우저의 보안 쿠키로 소유권을 확인합니다/u);
});

test('container builds receive the public captcha keys used by the client bundle', () => {
  assert.match(dockerfile, /ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY/u);
  assert.match(dockerfile, /ARG NEXT_PUBLIC_HCAPTCHA_SITE_KEY/u);
  assert.match(dockerfile, /ARG NEXT_PUBLIC_WIKI_ANONYMOUS_EDIT_REQUESTS_ENABLED/u);
  assert.match(compose, /NEXT_PUBLIC_TURNSTILE_SITE_KEY: \$\{NEXT_PUBLIC_TURNSTILE_SITE_KEY:-\}/u);
  assert.match(compose, /NEXT_PUBLIC_HCAPTCHA_SITE_KEY: \$\{NEXT_PUBLIC_HCAPTCHA_SITE_KEY:-\}/u);
  assert.match(compose, /NEXT_PUBLIC_WIKI_ANONYMOUS_EDIT_REQUESTS_ENABLED: \$\{NEXT_PUBLIC_WIKI_ANONYMOUS_EDIT_REQUESTS_ENABLED:-false\}/u);
});
