import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithFullHttpRequestContext } from '../common/http/request-context';
import { writeAuditEvent } from './audit-event-writer';

test('transactional audit writer applies request context and recursive redaction', async () => {
  let written: { data: Record<string, unknown> } | undefined;
  const store = { auditEvent: { async create(input: { data: Record<string, unknown> }) { written = input; return {}; } } };

  await runWithFullHttpRequestContext({
    requestIp: '198.51.100.8', requestId: 'request-123', userAgent: 'MineWiki-Test/1.0',
  }, () => writeAuditEvent(store as never, 'account.contact_email.changed', {
    category: 'account', actorAccountId: 'account-1', subjectType: 'account', subjectId: 'account-1',
    metadata: {
      token: 'raw-token', revokedWikiApiTokenCount: 3, disabledPluginCredentials: 2,
      nested: { password: 'raw-password', outcome: 'confirmed' },
    },
  }));

  assert.equal(written?.data.requestId, 'request-123');
  assert.equal(written?.data.ipAddress, '198.51.100.8');
  assert.equal(written?.data.userAgent, 'MineWiki-Test/1.0');
  assert.deepEqual(written?.data.metadata, {
    token: '[redacted]', revokedWikiApiTokenCount: 3, disabledPluginCredentials: 2,
    nested: { password: '[redacted]', outcome: 'confirmed' },
  });
});

test('explicit audit context overrides ambient HTTP context', async () => {
  let written: { data: Record<string, unknown> } | undefined;
  const store = { auditEvent: { async create(input: { data: Record<string, unknown> }) { written = input; return {}; } } };
  await runWithFullHttpRequestContext({ requestIp: '192.0.2.1', requestId: 'ambient', userAgent: 'ambient-agent' }, () =>
    writeAuditEvent(store as never, 'wiki.profile.rename', {
      requestId: 'explicit', ipAddress: '203.0.113.2', userAgent: 'explicit-agent',
    }));
  assert.equal(written?.data.requestId, 'explicit');
  assert.equal(written?.data.ipAddress, '203.0.113.2');
  assert.equal(written?.data.userAgent, 'explicit-agent');
});
