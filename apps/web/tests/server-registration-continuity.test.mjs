import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [registration, claim, claimPreference, controller, service, editor, captcha] =
  await Promise.all([
  readFile(new URL('../app/servers/register/page.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/claim/claim-workflow.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../lib/claim-method-preference.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../api/src/server/server.controller.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../api/src/server/server.service.ts', import.meta.url), 'utf8'),
  readFile(new URL('../components/servers/server-description-editor.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/security/captcha-challenge.tsx', import.meta.url), 'utf8'),
  ]);

test('server registration preserves account-scoped drafts and clears them only after creation', () => {
  assert.match(registration, /minewiki:server-registration-draft/u);
  assert.match(registration, /draftOwnerId !== account\.id/u);
  assert.match(registration, /parseStoredRegistrationDraft/u);
  assert.match(registration, /localStorage\.removeItem/u);
});

test('registration prioritizes verification and defers banner work to server settings', () => {
  assert.doesNotMatch(registration, /id="server-banner"/u);
  assert.doesNotMatch(registration, /uploadBanner/u);
  assert.match(registration, /다음: 소유권 검증/u);
  assert.match(registration, /배너\/태그 확인/u);
});

test('registration is authenticated, captcha protected, throttled and reserves canonical endpoints', () => {
  assert.match(controller, /@Throttle\(\{ default: \{ limit: 5, ttl: 300 \} \}\)/u);
  assert.match(controller, /verifyCaptcha\(captchaToken, request\.clientIp\)/u);
  assert.match(controller, /registrantAccountId: session\.userId/u);
  assert.match(service, /createRegistrationEndpointKey/u);
  assert.match(service, /registrationLeaseExpiresAt/u);
  assert.match(service, /isEndpointUniqueConstraintError/u);
});

test('registration keeps mobile actions visible and connects labels to every primary field', () => {
  assert.match(registration, /lg:sticky lg:top-24/u);
  assert.doesNotMatch(registration, /className="sticky top-24/u);

  for (const id of [
    'server-name',
    'server-join-host',
    'server-join-port',
    'server-short-description',
    'server-long-description',
    'server-tags',
    'server-website-url',
    'server-discord-url',
  ]) {
    assert.match(registration, new RegExp(`htmlFor="${id}"`, 'u'));
    assert.match(registration, new RegExp(`(?:id|textareaId)="${id}"`, 'u'));
  }
  assert.match(registration, /role="radiogroup"/u);
  assert.match(registration, /aria-labelledby="supported-versions-label"/u);
  assert.match(editor, /id=\{textareaId\}/u);
});

test('registration hierarchy separates completeness from trust and previews the next step', () => {
  assert.doesNotMatch(registration, /label: '검증 이동'/u);
  assert.doesNotMatch(registration, /등록 후 MOTD 검증으로 이동합니다/u);
  assert.match(registration, /정보 완성도/u);
  assert.match(registration, /소유권 신뢰/u);
  assert.match(registration, /어떤 방식으로 소유권을 증명할 수 있나요/u);
  assert.match(registration, /title="DNS TXT"/u);
  assert.match(registration, /서버 MOTD/u);
  assert.match(registration, /2\. 소유권 검증/u);
  assert.match(registration, /fixed inset-x-0 bottom-0/u);
  assert.match(captcha, /language: 'ko'/u);
});

test('claim recovery restores the active method and explains secure token reissuance', () => {
  assert.ok(claim.includes('router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`)'));
  assert.match(claim, /window\.location\.pathname.*window\.location\.search/u);
  assert.match(claimPreference, /minewiki_claim_selected_method/u);
  assert.match(registration, /persistClaimMethodPreference/u);
  assert.match(claim, /loadClaimMethodPreference/u);
  assert.match(claim, /preferredClaimMethod\(status\.methods\)/u);
  assert.match(claim, /이전 토큰은 다시 표시되지 않습니다\. 새 토큰을 재발급해 주세요/u);
  assert.match(claim, /검증 토큰 재발급/u);
  assert.match(claim, /codeValues: \['_cvverify', '_minewiki', '_claim'\]/u);
});
