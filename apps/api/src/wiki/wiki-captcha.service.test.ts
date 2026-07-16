import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { WikiCaptchaService } from './wiki-captcha.service';

test('wiki captcha fails closed when a configured verifier rejects the token', async () => {
  let received: { token?: string | null; ip?: string } | null = null;
  const captcha = {
    isCaptchaRequired() { return true; },
    async verifyCaptcha(token?: string | null, ip?: string) {
      received = { token, ip };
      return { success: false, errors: ['missing_token'] };
    },
  };
  const service = new WikiCaptchaService(captcha as never);

  await assert.rejects(service.assertVerified(null, '192.0.2.15'), BadRequestException);
  assert.deepEqual(received, { token: null, ip: '192.0.2.15' });
});

test('wiki captcha stays disabled when no provider secret is configured', async () => {
  let verified = false;
  const captcha = {
    isCaptchaRequired() { return false; },
    async verifyCaptcha() { verified = true; return { success: false }; },
  };
  await new WikiCaptchaService(captcha as never).assertVerified(null, '192.0.2.15');
  assert.equal(verified, false);
});
