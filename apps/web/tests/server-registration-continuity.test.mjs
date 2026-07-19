import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [registration, claim, controller, service] = await Promise.all([
  readFile(new URL('../app/servers/register/page.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/claim/claim-workflow.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../api/src/server/server.controller.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../api/src/server/server.service.ts', import.meta.url), 'utf8'),
]);

test('server registration preserves account-scoped drafts and clears them only after creation', () => {
  assert.match(registration, /minewiki:server-registration-draft/u);
  assert.match(registration, /draftOwnerId !== account\.id/u);
  assert.match(registration, /parseStoredRegistrationDraft/u);
  assert.match(registration, /localStorage\.removeItem/u);
});

test('optional banner upload has a bounded handoff and a visible recovery path', () => {
  assert.match(registration, /signal: AbortSignal\.timeout\(15_000\)/u);
  assert.match(registration, /bannerUploaded = await uploadBanner/u);
  assert.match(registration, /registrationBanner=failed/u);
  assert.match(claim, /params\.get\('registrationBanner'\) === 'failed'/u);
  assert.match(claim, /소유권 검증 후 서버 관리 화면에서 다시 업로드/u);
});

test('registration is authenticated, captcha protected, throttled and reserves canonical endpoints', () => {
  assert.match(controller, /@Throttle\(\{ default: \{ limit: 5, ttl: 300 \} \}\)/u);
  assert.match(controller, /verifyCaptcha\(captchaToken, request\.clientIp\)/u);
  assert.match(controller, /registrantAccountId: session\.userId/u);
  assert.match(service, /createRegistrationEndpointKey/u);
  assert.match(service, /registrationLeaseExpiresAt/u);
  assert.match(service, /isEndpointUniqueConstraintError/u);
});
