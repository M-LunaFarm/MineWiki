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
