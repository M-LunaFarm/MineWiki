import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleService } from './role.service';

test('role service resolves role and permission codes for an account', async () => {
  const prisma = {
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
