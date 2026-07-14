import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiAdminService } from './wiki-admin.service';
import { WikiPageAclService } from './wiki-page-acl.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';

const session: SessionPayload = {
  sessionId: 'session-1',
  userId: 'account-1',
  isElevated: false,
  authenticatedAt: '2026-07-14T00:00:00.000Z'
};

function page() {
  return {
    id: 7n,
    namespaceId: 1,
    spaceId: 2n,
    title: '대문',
    displayTitle: '대문',
    protectionLevel: 'open',
    status: 'normal',
    createdBy: 3n
  };
}

test('page ACL creation always fixes the target to the authorized page', async () => {
  let created: Record<string, unknown> | null = null;
  const prisma = {
    wikiPage: { async findUnique() { return page(); } }
  };
  const profiles = {
    async ensureWikiProfile() { return { id: 3n, status: 'active' }; }
  };
  const permissions = {
    actorFromSession() { return { accountId: 'account-1', profileId: 3n, status: 'active' }; },
    async assertCanManagePageAcl() {}
  };
  const admin = {
    async createAclRule(input: Record<string, unknown>) { created = input; return { id: '9' }; }
  };
  const service = new WikiPageAclService(
    prisma as unknown as PrismaService,
    profiles as unknown as WikiProfileService,
    permissions as unknown as WikiPermissionService,
    admin as unknown as WikiAdminService
  );

  await service.createRule('7', session, {
    action: 'edit', effect: 'allow', subjectType: 'perm', subjectValue: 'member'
  });

  assert.equal(created?.targetType, 'page');
  assert.equal(created?.targetId, '7');
  assert.equal(created?.actorProfileId, 3n);
});

test('page ACL accepts separate thread creation and comment actions', async () => {
  const createdActions: string[] = [];
  const prisma = {
    wikiPage: { async findUnique() { return page(); } }
  };
  const profiles = {
    async ensureWikiProfile() { return { id: 3n, status: 'active' }; }
  };
  const permissions = {
    actorFromSession() { return { accountId: 'account-1', profileId: 3n, status: 'active' }; },
    async assertCanManagePageAcl() {}
  };
  const admin = {
    async createAclRule(input: { action?: string }) {
      createdActions.push(input.action ?? '');
      return { id: String(createdActions.length) };
    }
  };
  const service = new WikiPageAclService(
    prisma as unknown as PrismaService,
    profiles as unknown as WikiProfileService,
    permissions as unknown as WikiPermissionService,
    admin as unknown as WikiAdminService
  );

  for (const action of ['create_thread', 'write_thread_comment']) {
    await service.createRule('7', session, {
      action, effect: 'allow', subjectType: 'perm', subjectValue: 'member'
    });
  }

  assert.deepEqual(createdActions, ['create_thread', 'write_thread_comment']);
});

test('page ACL deletion cannot address a rule owned by another page', async () => {
  let deleted = false;
  const prisma = {
    wikiPage: { async findUnique() { return page(); } },
    aclRule: { async findUnique() { return { id: 9n, targetType: 'page', targetId: 8n }; } }
  };
  const profiles = {
    async ensureWikiProfile() { return { id: 3n, status: 'active' }; }
  };
  const permissions = {
    actorFromSession() { return { accountId: 'account-1', profileId: 3n, status: 'active' }; },
    async assertCanManagePageAcl() {}
  };
  const admin = {
    async deleteAclRule() { deleted = true; }
  };
  const service = new WikiPageAclService(
    prisma as unknown as PrismaService,
    profiles as unknown as WikiProfileService,
    permissions as unknown as WikiPermissionService,
    admin as unknown as WikiAdminService
  );

  await assert.rejects(service.deleteRule('7', '9', session), /not found/i);
  assert.equal(deleted, false);
});

test('page ACL creation rejects past expirations before persistence', async () => {
  let created = false;
  const prisma = {
    wikiPage: { async findUnique() { return page(); } }
  };
  const profiles = {
    async ensureWikiProfile() { return { id: 3n, status: 'active' }; }
  };
  const permissions = {
    actorFromSession() { return { accountId: 'account-1', profileId: 3n, status: 'active' }; },
    async assertCanManagePageAcl() {}
  };
  const admin = {
    async createAclRule() { created = true; }
  };
  const service = new WikiPageAclService(
    prisma as unknown as PrismaService,
    profiles as unknown as WikiProfileService,
    permissions as unknown as WikiPermissionService,
    admin as unknown as WikiAdminService
  );

  await assert.rejects(
    service.createRule('7', session, {
      action: 'edit', effect: 'allow', subjectType: 'perm', subjectValue: 'member', expiresAt: '2020-01-01T00:00:00.000Z'
    }),
    /future date/i
  );
  assert.equal(created, false);
});
