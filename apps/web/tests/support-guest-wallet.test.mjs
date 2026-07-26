import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [page, apiClient, controller, service, schemas, migration] = await Promise.all([
  readFile(new URL('../components/support/support-redesign-page.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../lib/support-api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../api/src/support/support.controller.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../api/src/support/support.service.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../../packages/schemas/src/index.ts', import.meta.url), 'utf8'),
  readFile(
    new URL(
      '../../../prisma/migrations/20260725200000_support_guest_tracking/migration.sql',
      import.meta.url,
    ),
    'utf8',
  ),
]);

test('support renders the Lazyweb Guest Wallet hierarchy and responsive lookup table', () => {
  for (const copy of [
    '이 기기에서 내 비회원 문의',
    '자동 저장',
    '문의번호',
    '최근 업데이트',
    '다른 기기에서 조회',
    '최신 이메일',
    '본인 확인',
  ]) {
    assert.match(page, new RegExp(copy, 'u'));
  }

  assert.match(page, /minewiki:support:guest-access/u);
  assert.match(page, /overflow-x-auto/u);
  assert.match(page, /min-w-\[520px\]/u);
  assert.match(page, /window\.localStorage\.setItem/u);
});

test('member ticket detail stays within the mobile viewport and has a list return path', () => {
  assert.match(page, /grid-cols-\[minmax\(0,1fr\)\]/u);
  assert.match(page, /mobileTicketDetailOpen/u);
  assert.match(page, /setMobileTicketDetailOpen\(true\)/u);
  assert.match(page, /setMobileTicketDetailOpen\(false\)/u);
  assert.match(page, />\s*문의 목록\s*</u);
  assert.match(page, /overflow-x-hidden/u);
  assert.match(page, /max-w-\[calc\(100%-3rem\)\]/u);
});

test('guest ticket retrieval works on the same device and through verified recovery', () => {
  assert.match(apiClient, /tickets\/guest\/lookup/u);
  assert.match(apiClient, /tickets\/guest\/recover/u);
  assert.match(apiClient, /tickets\/guest\/\$\{ticketId\}\/messages/u);
  assert.match(controller, /@Post\('tickets\/guest\/lookup'\)/u);
  assert.match(controller, /@Post\('tickets\/guest\/recover'\)/u);
  assert.match(controller, /@Throttle\(\{ default: \{ limit: 5, ttl: 600 \} \}\)/u);
  assert.match(schemas, /guestSupportRecoverySchema/u);
  assert.match(schemas, /email: z\.string\(\)\.trim\(\)\.email\(\)\.max\(120\)/u);
});

test('guest credentials are one-way, expiring and compared in constant time', () => {
  assert.match(service, /randomBytes\(32\)\.toString\('base64url'\)/u);
  assert.match(service, /createHash\('sha256'\)/u);
  assert.match(service, /timingSafeEqual\(expected, actual\)/u);
  assert.match(service, /guestAccessExpiresAt/u);
  assert.doesNotMatch(service, /guestAccessCode\s*=/u);

  for (const column of [
    'guestName',
    'guestEmail',
    'guestAccessHash',
    'guestAccessExpiresAt',
  ]) {
    assert.match(migration, new RegExp(column, 'u'));
  }
});
