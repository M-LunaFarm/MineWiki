import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { RoleAdminController } from './role-admin.controller';
import type { SessionPayload } from '../session/session.service';

const adminSession: SessionPayload = {
  sessionId: 'session-admin',
  userId: 'admin-account',
  isElevated: false,
  groups: ['admin'],
  permissions: [],
};

const ownerSession: SessionPayload = {
  ...adminSession,
  userId: 'owner-account',
  groups: ['owner'],
};

test('role admin denies non-admin sessions', async () => {
  const controller = createController();
  await assert.rejects(
    () => controller.listRoles({ ...adminSession, groups: [] }),
    ForbiddenException,
  );
});

test('admin cannot grant protected owner role', async () => {
  const controller = createController();
  await assert.rejects(
    () => controller.assignRole('account-1', { roleCode: 'owner' }, adminSession),
    (error: unknown) =>
      error instanceof ForbiddenException && /only an owner/i.test(error.message),
  );
});

test('owner can grant a protected role and action is audited', async () => {
  const audits: Array<{ action: string; input: unknown }> = [];
  const roles = {
    async assignRole(accountId: string, roleCode: string) {
      assert.equal(accountId, 'account-1');
      assert.equal(roleCode, 'admin');
      return { roles: ['admin'], permissions: ['wiki.admin'] };
    },
  };
  const events = {
    async audit(action: string, input: unknown) {
      audits.push({ action, input });
    },
  };
  const controller = new RoleAdminController(roles as never, events as never);

  const access = await controller.assignRole(
    'account-1',
    { roleCode: 'admin' },
    ownerSession,
  );

  assert.deepEqual(access.roles, ['admin']);
  assert.equal(audits[0]?.action, 'admin.role.assigned');
});

function createController(): RoleAdminController {
  return new RoleAdminController(
    {
      async listRoles() {
        return [];
      },
    } as never,
    { async audit() {} } as never,
  );
}
