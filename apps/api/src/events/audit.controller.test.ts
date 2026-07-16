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
