import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_PERMISSION_CODES, RoleService } from './role.service';

test('built-in permissions include every delegated wiki moderation surface', () => {
  assert.ok(BUILT_IN_PERMISSION_CODES.includes('wiki.user.block'));
  assert.ok(BUILT_IN_PERMISSION_CODES.includes('wiki.batch_rollback'));
  assert.ok(BUILT_IN_PERMISSION_CODES.includes('wiki.report.moderate'));
  assert.ok(BUILT_IN_PERMISSION_CODES.includes('admin.audit.read'));
});

test('role service resolves role and permission codes for an account', async () => {
  const prisma = {
    account: {
      async findUnique() {
        return { id: 'account-1', canonicalAccountId: null };
      },
    },
    accountRole: {
      async findMany() {
        return [
          {
            role: {
              code: 'wiki_admin',
              rolePermissions: [
                { permission: { code: 'wiki.admin' } },
                { permission: { code: 'wiki.edit.locked' } },
              ],
            },
          },
        ];
      },
    },
  };
  const service = new RoleService(prisma as never);
  const access = await service.getAccountAccess('account-1');

  assert.deepEqual(access.roles, ['wiki_admin']);
  assert.deepEqual(access.permissions, ['wiki.admin', 'wiki.edit.locked']);
  assert.equal(await service.hasPermission('account-1', 'wiki.admin'), true);
});

test('role service assigns an existing role idempotently', async () => {
  let upsertInput: unknown;
  const prisma = {
    globalRole: {
      async findUnique() {
        return { id: 'role-1', code: 'support_agent' };
      },
    },
    account: {
      async findUnique() {
        return { id: 'account-1', canonicalAccountId: null };
      },
    },
    accountRole: {
      async upsert(input: unknown) {
        upsertInput = input;
      },
      async findMany() {
        return [{ role: { code: 'support_agent', rolePermissions: [] } }];
      },
    },
  };
  const service = new RoleService(prisma as never);

  const access = await service.assignRole('account-1', 'support_agent');

  assert.deepEqual(access.roles, ['support_agent']);
  assert.deepEqual(upsertInput, {
    where: { accountId_roleId: { accountId: 'account-1', roleId: 'role-1' } },
    update: {},
    create: { accountId: 'account-1', roleId: 'role-1' },
  });
});
