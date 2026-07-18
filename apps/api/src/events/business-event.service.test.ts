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

test('audit page uses a stable cursor, operational filters, and read-time redaction', async () => {
  let query: Record<string, unknown> | undefined;
  const row = (id: string, minute: number) => ({
    id, category: 'account', action: 'account.contact_email.changed', severity: 'warning',
    actorAccountId: 'actor-1', actorProfileId: null, subjectType: 'account', subjectId: 'subject-1',
    requestId: 'request-1', ipAddress: '203.0.113.1', userAgent: 'agent',
    metadata: { token: 'legacy-secret', outcome: 'confirmed' },
    createdAt: new Date(`2026-07-18T10:0${minute}:00.000Z`),
  });
  const prisma = { auditEvent: {
    async findMany(input: Record<string, unknown>) { query = input; return [row('event-3', 3), row('event-2', 2), row('event-1', 1)]; },
    async findUnique() { return { id: 'event-2' }; },
  } };
  const service = new BusinessEventService(prisma as never);

  const page = await service.listAuditEventPage({
    category: 'account', action: 'contact_email', severity: 'warning', actorAccountId: 'actor-1', limit: 2,
  });

  assert.equal(page.items.length, 2);
  assert.equal(page.nextCursor, 'event-2');
  assert.equal(page.items[0]?.ipAddress, null);
  assert.equal(page.items[0]?.userAgent, null);
  assert.deepEqual(page.items[0]?.metadata, { token: '[redacted]', outcome: 'confirmed' });
  assert.deepEqual(query?.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
  assert.equal(query?.take, 3);
  assert.deepEqual((query?.where as Record<string, unknown>).action, { contains: 'contact_email' });
});
