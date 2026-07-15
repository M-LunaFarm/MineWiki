import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
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
    () => controller.listRoles({ ...adminSession, isElevated: true, groups: [] }),
    ForbiddenException,
  );
});

test('admin cannot grant protected owner role', async () => {
  const controller = createController();
  await assert.rejects(
    () => controller.assignRole('account-1', { roleCode: 'owner' }, { ...adminSession, isElevated: true }),
    (error: unknown) =>
      error instanceof ForbiddenException && /only an owner/i.test(error.message),
  );
});

test('owner can grant a protected role and action is audited', async () => {
  const audits: Array<{ action: string; input: unknown }> = [];
  const roles = {
    async assignRole(
      accountId: string,
      roleCode: string,
      options: { actorAccountId?: string },
    ) {
      assert.equal(accountId, 'account-1');
      assert.equal(roleCode, 'admin');
      assert.equal(options.actorAccountId, ownerSession.userId);
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

test('owner cannot grant a protected role to an account without MFA', async () => {
  const controller = new RoleAdminController(
    {
      async assignRole() {
        throw new BadRequestException(
          '보호된 관리자 역할을 받으려면 대상 계정에 다중 인증이 활성화되어 있어야 합니다.',
        );
      },
    } as never,
    { async audit() {} } as never,
  );

  await assert.rejects(
    () => controller.assignRole('account-1', { roleCode: 'wiki_admin' }, ownerSession),
    BadRequestException,
  );
});

test('owner cannot grant a protected role to the active account itself', async () => {
  const controller = new RoleAdminController(
    {
      async assignRole(
        accountId: string,
        roleCode: string,
        options: { actorAccountId?: string },
      ) {
        assert.equal(accountId, ownerSession.userId);
        assert.equal(roleCode, 'admin');
        assert.equal(options.actorAccountId, ownerSession.userId);
        throw new ForbiddenException('자기 계정 그룹에는 보호된 관리자 역할을 부여할 수 없습니다.');
      },
    } as never,
    { async audit() {} } as never,
  );

  await assert.rejects(
    () => controller.assignRole(ownerSession.userId, { roleCode: 'admin' }, ownerSession),
    ForbiddenException,
  );
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
