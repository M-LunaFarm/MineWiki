import test from 'node:test';
import assert from 'node:assert/strict';
import { BusinessEventService, redactAuditValue } from './business-event.service';

test('audit redaction removes sensitive token and secret fields recursively', () => {
  const redacted = redactAuditValue({
    verifyToken: 'verify-token',
    completionToken: 'completion-token',
    serverSecret: 'server-secret',
    headers: {
      Authorization: 'Bearer secret',
      ok: 'kept'
    },
    oauth: {
      access_token: 'access-token',
      refreshToken: 'refresh-token'
    },
    nested: [{ password: 'pw' }, { value: 'safe' }]
  }) as {
    verifyToken: string;
    completionToken: string;
    serverSecret: string;
    headers: { Authorization: string; ok: string };
    oauth: { access_token: string; refreshToken: string };
    nested: Array<{ password?: string; value?: string }>;
  };

  assert.equal(redacted.verifyToken, '[redacted]');
  assert.equal(redacted.completionToken, '[redacted]');
  assert.equal(redacted.serverSecret, '[redacted]');
  assert.equal(redacted.headers.Authorization, '[redacted]');
  assert.equal(redacted.headers.ok, 'kept');
  assert.equal(redacted.oauth.access_token, '[redacted]');
  assert.equal(redacted.oauth.refreshToken, '[redacted]');
  assert.equal(redacted.nested[0].password, '[redacted]');
  assert.equal(redacted.nested[1].value, 'safe');
});

test('audit persists redacted metadata', async () => {
  const writes: unknown[] = [];
  const prisma = {
    auditEvent: {
      create: async (input: unknown) => {
        writes.push(input);
      }
    }
  };
  const service = new BusinessEventService(prisma as never);

  await service.audit('discord.verify.session.created', {
    metadata: {
      verificationUrl: 'https://minewiki.test/verify?verifyToken=token',
      verifyToken: 'token',
      payload: {
        completionToken: 'completion'
      }
    }
  });

  assert.equal(writes.length, 1);
  const write = writes[0] as {
    data: {
      category: string;
      metadata: {
        verificationUrl: string;
        verifyToken: string;
        payload: { completionToken: string };
      };
    };
  };
  assert.equal(write.data.category, 'discord.verify');
  assert.equal(write.data.metadata.verifyToken, '[redacted]');
  assert.equal(write.data.metadata.payload.completionToken, '[redacted]');
  assert.match(write.data.metadata.verificationUrl, /verifyToken=%5Bredacted%5D|verifyToken=\\[redacted\\]/);
  assert.doesNotMatch(write.data.metadata.verificationUrl, /verifyToken=token/);
});
