import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiEditService } from './wiki-edit.service';
import { WikiEditRequestService } from './wiki-edit-request.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';
import type { WikiRoutePathResolver } from './wiki-route-path.resolver';

const session = { userId: 'account-1' } as SessionPayload;
const page = {
  id: 10n, namespaceId: 1, spaceId: 2n, localPath: 'guide', slug: 'guide', title: 'Guide', displayTitle: 'Guide',
  currentRevisionId: 30n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 20n,
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z')
};
const request = {
  id: 40n, pageId: page.id, baseRevisionId: 30n, proposedContent: 'next', editSummary: 'update', isMinor: false,
  status: 'pending', createdBy: 99n, reviewedBy: null, reviewNote: null, acceptedRevisionId: null,
  createdAt: new Date('2026-01-02T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'), reviewedAt: null
};

function createService(canManage = false) {
  const prisma = {
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    async $queryRaw() { return [{ id: page.id }]; },
    wikiPage: { async findUnique() { return page; } },
    wikiEditRequest: {
      async findUnique() { return request; },
      async findFirst() { return null; },
      async create() { throw new Error('create should not run'); }
    }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 20n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    async assertCanReadPage() {},
    async assertCanUsePageAction() {},
    actorFromSession() { return { accountId: session.userId, profileId: 20n, status: 'active' }; },
    async canManagePage() { return canManage; }
  } as unknown as WikiPermissionService;
  return new WikiEditRequestService(prisma, profiles, permissions, {} as WikiEditService);
}

test('edit request creation rejects a stale base revision before persistence', async () => {
  await assert.rejects(
    createService().create(session, page.id.toString(), {
      baseRevisionId: '29', contentRaw: 'new content', editSummary: 'change'
    }),
    ConflictException
  );
});

test('edit request detail enforces page visibility and returns the exact request', async () => {
  let readChecked = false;
  let rawChecked = false;
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiEditRequest: { async findUnique() { return request; } },
    wikiProfile: { async findMany() { return [{ id: 99n, displayName: '작성자' }]; } }
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadPage() { readChecked = true; },
    async assertCanUsePageAction(input: { action: string }) {
      assert.equal(input.action, 'raw');
      rawChecked = true;
    }
  } as unknown as WikiPermissionService;

  const result = await new WikiEditRequestService(prisma, {} as WikiProfileService, permissions, {} as WikiEditService).get('40');

  assert.equal(result.id, '40');
  assert.equal(result.pageId, '10');
  assert.equal(result.createdByName, '작성자');
  assert.equal(readChecked, true);
  assert.equal(rawChecked, true);
});

test('global edit request queue resolves readable pages and reviewer capability', async () => {
  const prisma = {
    wikiEditRequest: { async findMany() { return [request]; } },
    wikiPage: { async findMany() { return [page]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'guide' }]; } },
    wikiProfile: { async findMany() { return [{ id: 99n, displayName: '작성자' }]; } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 20n, status: 'active' }; } } as unknown as WikiProfileService;
  const actions: string[] = [];
  const permissions = {
    async assertCanReadPage() { actions.push('read'); },
    async assertCanUsePageAction(input: { action: string }) { actions.push(input.action); },
    actorFromSession() { return { accountId: session.userId, profileId: 20n, status: 'active' }; },
    async canManagePage() { return true; }
  } as unknown as WikiPermissionService;
  const routes = {
    async preload() { return { routePath() { return '/guide/guide'; } }; }
  } as unknown as WikiRoutePathResolver;
  const service = new WikiEditRequestService(
    prisma,
    profiles,
    permissions,
    {} as WikiEditService,
    undefined,
    undefined,
    routes
  );

  const result = await service.listGlobal(session, { status: 'open', namespace: 'guide' });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.routePath, '/guide/guide');
  assert.equal(result.items[0]?.canReview, true);
  assert.equal(result.items[0]?.namespace, 'guide');
  assert.equal(result.viewerProfileId, '20');
  assert.deepEqual(actions, ['read', 'raw']);
});

test('only a page manager can reject an edit request', async () => {
  await assert.rejects(
    createService(false).reject(session, request.id.toString(), 'not accepted'),
    ForbiddenException
  );
});

test('the author can rebase, close, and reopen an edit request', async () => {
  const stored = {
    ...request,
    status: 'stale',
    baseRevisionId: 29n,
    proposedContent: '== 소개 ==\n내 변경\n\n== 접속 ==\nold.example.kr\n'
  };
  const prisma = {
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    async $queryRaw() { return [{ id: page.id }]; },
    wikiPage: { async findUnique() { return page; } },
    wikiProfile: { async findMany() { return [{ id: 99n, displayName: '작성자' }]; } },
    wikiPageRevision: {
      async findUnique(args: { where: { id: bigint } }) {
        if (args.where.id === 29n) {
          return {
            id: 29n,
            pageId: page.id,
            revisionNo: 1,
            visibility: 'public',
            contentRaw: '== 소개 ==\n기준\n\n== 접속 ==\nold.example.kr\n'
          };
        }
        if (args.where.id === 30n) {
          return {
            id: 30n,
            pageId: page.id,
            revisionNo: 2,
            visibility: 'public',
            contentRaw: '== 소개 ==\n기준\n\n== 접속 ==\nplay.example.kr\n'
          };
        }
        return null;
      }
    },
    wikiEditRequest: {
      async findUnique() { return { ...stored }; },
      async findUniqueOrThrow() { return { ...stored }; },
      async findFirst() { return null; },
      async updateMany(args: { where: { status: string }; data: Record<string, unknown> }) {
        if (stored.status !== args.where.status) return { count: 0 };
        Object.assign(stored, args.data);
        return { count: 1 };
      }
    }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 99n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    async assertCanReadPage() {},
    async assertCanUsePageAction() {}
  } as unknown as WikiPermissionService;
  const service = new WikiEditRequestService(prisma, profiles, permissions, {} as WikiEditService);

  const updated = await service.rebase(session, '40');
  assert.equal(updated.status, 'pending');
  assert.equal(updated.baseRevisionId, '30');
  assert.match(updated.proposedContent, /내 변경/);
  assert.match(updated.proposedContent, /play\.example\.kr/);

  assert.equal((await service.close(session, '40')).status, 'closed');
  assert.equal((await service.reopen(session, '40')).status, 'pending');
});

test('edit request diff is calculated from the exact base revision', async () => {
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiEditRequest: { async findUnique() { return request; } },
    wikiPageRevision: { async findUnique() { return { id: 30n, pageId: page.id, visibility: 'public', contentRaw: 'before' }; } }
  } as unknown as PrismaService;
  let rawChecked = false;
  const permissions = {
    async assertCanReadPage() {},
    async assertCanUsePageAction(input: { action: string }) {
      assert.equal(input.action, 'raw');
      rawChecked = true;
    }
  } as unknown as WikiPermissionService;
  let compared: [string, string] | null = null;
  const edits = { diffText(left: string, right: string) { compared = [left, right]; return [{ type: 'removed' as const, line: left, leftLine: 1, rightLine: null }]; } } as unknown as WikiEditService;
  const service = new WikiEditRequestService(prisma, {} as WikiProfileService, permissions, edits);

  const diff = await service.diff('40');
  assert.deepEqual(compared, ['before', 'next']);
  assert.equal(diff.baseRevisionId, '30');
  assert.equal(rawChecked, true);
});
