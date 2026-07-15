import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  totpCodeAt,
  verifyTotpCode,
} from './totp';

test('TOTP verifies only the current bounded time window', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const now = 1_720_000_000_000;
  const code = totpCodeAt(secret, now);

  assert.match(code, /^\d{6}$/);
  assert.equal(verifyTotpCode(secret, code, now), BigInt(Math.floor(now / 30_000)));
  assert.equal(verifyTotpCode(secret, code, now + 90_000), null);
  assert.equal(verifyTotpCode(secret, '00000x', now), null);
  assert.equal(verifyTotpCode(secret, code, now, 3), null);
});

test('generated TOTP secrets and recovery codes have high entropy encodings', () => {
  const first = generateTotpSecret();
  const second = generateTotpSecret();
  const codes = generateRecoveryCodes();

  assert.match(first, /^[A-Z2-7]{32}$/);
  assert.notEqual(first, second);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every((code) => /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}$/.test(code)));
  assert.throws(() => generateRecoveryCodes(21), RangeError);
});

test('recovery codes normalize separators and hash deterministically', () => {
  const code = 'ABCD-EFGH-IJKL-MNPQ';
  assert.equal(normalizeRecoveryCode(code.toLowerCase()), 'ABCDEFGHIJKLMNPQ');
  assert.equal(hashRecoveryCode(code), hashRecoveryCode('abcd efgh ijkl mnpq'));
  assert.equal(normalizeRecoveryCode('not-a-recovery-code'), '');
});
