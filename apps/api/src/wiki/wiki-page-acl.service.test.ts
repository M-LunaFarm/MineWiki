import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiAdminService } from './wiki-admin.service';
import type { WikiAclService } from './wiki-acl.service';
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
    admin as unknown as WikiAdminService,
    {} as WikiAclService
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
    admin as unknown as WikiAdminService,
    {} as WikiAclService
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
    admin as unknown as WikiAdminService,
    {} as WikiAclService
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
    admin as unknown as WikiAdminService,
    {} as WikiAclService
  );

  await assert.rejects(
    service.createRule('7', session, {
      action: 'edit', effect: 'allow', subjectType: 'perm', subjectValue: 'member', expiresAt: '2020-01-01T00:00:00.000Z'
    }),
    /future date/i
  );
  assert.equal(created, false);
});

test('page ACL rejects a group scoped to another wiki space', async () => {
  let created = false;
  const prisma = {
    wikiPage: { async findUnique() { return page(); } },
    aclGroup: {
      async findUnique() {
        return { status: 'active', scopeType: 'space', spaceId: 99n };
      }
    }
  };
  const profiles = { async ensureWikiProfile() { return { id: 3n, status: 'active' }; } };
  const permissions = {
    actorFromSession() { return { accountId: 'account-1', profileId: 3n, status: 'active' }; },
    async assertCanManagePageAcl() {}
  };
  const admin = { async createAclRule() { created = true; } };
  const service = new WikiPageAclService(
    prisma as unknown as PrismaService,
    profiles as unknown as WikiProfileService,
    permissions as unknown as WikiPermissionService,
    admin as unknown as WikiAdminService,
    {} as WikiAclService
  );

  await assert.rejects(
    service.createRule('7', session, {
      action: 'edit', effect: 'allow', subjectType: 'aclgroup', subjectValue: 'other_space'
    }),
    /this wiki space/i
  );
  assert.equal(created, false);
});

test('page readers do not receive manager-only ACL rules, subjects, reasons, or catalog', async () => {
  let catalogQueried = false;
  let rulesQueried = false;
  const prisma = {
    wikiPage: { async findUnique() { return page(); } },
    aclRule: { async findMany() { rulesQueried = true; return [{ subjectValue: 'private-user-42', reason: 'internal incident' }]; } },
    wikiGroup: { async findMany() { catalogQueried = true; return []; } },
    aclGroup: { async findMany() { catalogQueried = true; return []; } }
  };
  const permissions = {
    async assertCanReadPage() {},
    async canManagePageAcl() { return { allowed: false, reason: 'page_manager_required' }; }
  };
  const service = new WikiPageAclService(
    prisma as unknown as PrismaService,
    {} as WikiProfileService,
    permissions as unknown as WikiPermissionService,
    {} as WikiAdminService,
    {} as WikiAclService
  );

  const result = await service.getPageAcl('7', null);
  assert.equal(catalogQueried, false);
  assert.equal(rulesQueried, false);
  assert.deepEqual(result.rules, []);
  assert.deepEqual(result.layers, []);
  assert.deepEqual(result.viewerTrace, []);
  assert.equal(result.evaluatedAt, null);
  assert.doesNotMatch(JSON.stringify(result), /private-user-42|internal incident/);
  assert.equal(result.manageReason, 'insufficient_permission');
  assert.deepEqual(result.catalog, { groups: [], aclGroups: [], roles: [] });
});

test('page ACL managers receive the exact active inheritance stack and viewer trace', async () => {
  const now = new Date();
  const rule = (id: bigint, targetType: string, targetId: bigint | null, action = 'edit', expiresAt: Date | null = null) => ({
    id, targetType, targetId, action, effect: 'allow', subjectType: 'perm', subjectValue: 'member',
    sortOrder: Number(id), reason: `${targetType} reason`, expiresAt, createdBy: 3n, createdAt: now, updatedAt: now
  });
  const queriedWhere: unknown[] = [];
  const prisma = {
    wikiPage: { async findUnique() { return page(); } },
    aclRule: {
      async findMany(input: { where: unknown }) {
        queriedWhere.push(input.where);
        return [
          rule(1n, 'page', 7n),
          rule(2n, 'space', 2n),
          rule(3n, 'namespace', 1n),
          rule(4n, 'site', null),
          rule(5n, 'space', 99n),
          rule(6n, 'page', 7n, 'edit', new Date(now.getTime() - 1_000))
        ];
      }
    },
    wikiGroup: { async findMany() { return []; } },
    aclGroup: { async findMany() { return []; } }
  };
  const actor = { accountId: 'account-1', profileId: 3n, status: 'active' };
  const permissions = {
    async assertCanReadPage() {},
    async resolveActor() { return actor; },
    async canManagePageAcl() { return { allowed: true, reason: 'page_owner' }; }
  };
  const acl = {
    async evaluateActionsWithTrace(input: { actions: readonly string[]; requestIp?: string | null }) {
      assert.equal(input.requestIp, '192.0.2.10');
      return new Map(input.actions.map((action) => [action, action === 'edit'
        ? { matched: true, allowed: true, reason: 'space allow', matchedScope: 'space', matchedRuleId: 2n }
        : { matched: false, allowed: false, reason: 'acl_no_match', matchedScope: null, matchedRuleId: null }]));
    }
  };
  const service = new WikiPageAclService(
    prisma as unknown as PrismaService,
    {} as WikiProfileService,
    permissions as unknown as WikiPermissionService,
    {} as WikiAdminService,
    acl as unknown as WikiAclService
  );

  const result = await service.getPageAcl('7', { ...session, requestIp: '198.51.100.1' }, '192.0.2.10');

  assert.equal(queriedWhere.length, 1);
  assert.deepEqual(result.layers.map((layer) => [layer.scope, layer.targetId, layer.editableHere, layer.rules.map((entry) => entry.id)]), [
    ['page', '7', true, ['1']],
    ['space', '2', false, ['2']],
    ['namespace', '1', false, ['3']],
    ['site', null, false, ['4']]
  ]);
  assert.deepEqual(result.rules.map((entry) => entry.id), ['1']);
  assert.deepEqual(result.viewerTrace.find((entry) => entry.action === 'edit'), {
    action: 'edit', matched: true, allowed: true, matchedScope: 'space', matchedRuleId: '2', reason: 'space allow'
  });
  assert.ok(result.evaluatedAt);
  assert.doesNotMatch(JSON.stringify(result), /space reason.*99/u);
  assert.doesNotMatch(JSON.stringify(result), /"id":"6"/u);
});
