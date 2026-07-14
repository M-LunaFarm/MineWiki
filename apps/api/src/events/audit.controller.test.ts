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

test('audit log accepts an explicit administrator permission', async () => {
  const controller = new AuditController({
    async listAuditEvents() { return []; }
  } as never);

  assert.deepEqual(await controller.list({
    ...elevatedUser,
    isElevated: false,
    permissions: ['support.admin']
  }), []);
});
