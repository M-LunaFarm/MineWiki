import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { ConfigService } from '@minewiki/config';
import nodemailer from 'nodemailer';
import { EmailService } from './email.service';

test('SMTP transport cannot read local files or remote URLs', () => {
  let transportOptions: Record<string, unknown> | undefined;
  const createTransport = mock.method(nodemailer, 'createTransport', (options) => {
    transportOptions = options as Record<string, unknown>;
    return { sendMail: async () => undefined } as never;
  });

  try {
    const service = new EmailService(new ConfigService({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_FROM: 'support@minewiki.kr',
    } as NodeJS.ProcessEnv));

    assert.equal(service.isEnabled(), true);
    assert.equal(transportOptions?.disableFileAccess, true);
    assert.equal(transportOptions?.disableUrlAccess, true);
  } finally {
    createTransport.mock.restore();
  }
});

test('contact email messages send the verification token only to the new address and a masked notice to the old address', async () => {
  const messages: Array<Record<string, unknown>> = [];
  const createTransport = mock.method(nodemailer, 'createTransport', () => ({
    async sendMail(input: Record<string, unknown>) { messages.push(input); }
  }) as never);
  try {
    const service = new EmailService(new ConfigService({
      SMTP_HOST: 'smtp.example.com',
      SMTP_FROM: 'support@minewiki.kr',
      NEXT_PUBLIC_SITE_URL: 'https://minewiki.example',
    } as NodeJS.ProcessEnv));
    await service.sendContactEmailChangeVerificationEmail({
      email: 'new@example.com', token: 'secret-contact-token', expiresAt: new Date('2026-07-19T00:00:00.000Z'),
    });
    await service.sendContactEmailChangedNotice({
      email: 'old@example.com', newEmailMasked: 'ne***@example.com', changedAt: new Date('2026-07-18T00:00:00.000Z'),
    });

    assert.equal(messages[0]?.to, 'new@example.com');
    assert.match(String(messages[0]?.text), /secret-contact-token/u);
    assert.equal(messages[1]?.to, 'old@example.com');
    assert.match(String(messages[1]?.text), /ne\*\*\*@example\.com/u);
    assert.doesNotMatch(String(messages[1]?.text), /secret-contact-token/u);
  } finally {
    createTransport.mock.restore();
  }
});
