import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { AuditController } from './audit.controller';
import type { SessionPayload } from '../session/session.service';

const elevatedUser: SessionPayload = {
  sessionId: 'session-1',
  userId: 'account-1',
  isElevated: true,
  groups: [],
  permissions: []
};

test('audit log rejects elevation without administrator authority', async () => {
  let queried = false;
  const controller = new AuditController({
    async listAuditEvents() { queried = true; return []; }
  } as never);

  await assert.rejects(
    () => controller.list(elevatedUser),
    (error: unknown) => error instanceof ForbiddenException
  );
  assert.equal(queried, false);
});

test('audit log rejects unrelated domain administrator permissions', async () => {
  let queried = false;
  const controller = new AuditController({
    async listAuditEvents() { queried = true; return []; }
  } as never);

  for (const permission of ['support.admin', 'server.admin', 'file.admin', 'guild.admin', 'wiki.admin']) {
    await assert.rejects(
      () => controller.list({ ...elevatedUser, permissions: [permission] }),
      (error: unknown) => error instanceof ForbiddenException
    );
  }
  assert.equal(queried, false);
});

test('audit log accepts only global administrators or the explicit audit permission', async () => {
  const controller = new AuditController({
    async listAuditEvents() { return []; }
  } as never);

  assert.deepEqual(await controller.list({
    ...elevatedUser,
    isElevated: false,
    permissions: ['admin.audit.read']
  }), []);
  assert.deepEqual(await controller.list({ ...elevatedUser, groups: ['admin'] }), []);
  assert.deepEqual(await controller.list({ ...elevatedUser, groups: ['owner'] }), []);
});

test('audit page forwards filters and restricts sensitive network context to trusted administrators', async () => {
  const inputs: unknown[] = [];
  const controller = new AuditController({
    async listAuditEventPage(input: unknown) { inputs.push(input); return { items: [], nextCursor: null }; }
  } as never);

  await controller.page(
    { ...elevatedUser, permissions: ['admin.audit.read'] },
    'account', 'contact_email', 'warning', 'actor-1', 'account', 'subject-1', 'request-1', undefined, '50',
  );
  await controller.page(
    { ...elevatedUser, groups: ['admin'] },
    'wiki', undefined, undefined, undefined, undefined, undefined, undefined, 'cursor-1', '25',
  );

  assert.deepEqual(inputs, [
    {
      category: 'account', action: 'contact_email', severity: 'warning', actorAccountId: 'actor-1',
      subjectType: 'account', subjectId: 'subject-1', requestId: 'request-1', cursor: undefined,
      limit: '50', includeSensitive: false,
    },
    {
      category: 'wiki', action: undefined, severity: undefined, actorAccountId: undefined,
      subjectType: undefined, subjectId: undefined, requestId: undefined, cursor: 'cursor-1',
      limit: '25', includeSensitive: true,
    },
  ]);
});
