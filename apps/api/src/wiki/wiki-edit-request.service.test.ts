import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiEditService } from './wiki-edit.service';
import { WikiEditRequestService } from './wiki-edit-request.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';

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

test('only a page manager can reject an edit request', async () => {
  await assert.rejects(
    createService(false).reject(session, request.id.toString(), 'not accepted'),
    ForbiddenException
  );
});

test('the author can rebase, close, and reopen an edit request', async () => {
  const stored = { ...request, status: 'stale', baseRevisionId: 29n };
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiProfile: { async findMany() { return [{ id: 99n, displayName: '작성자' }]; } },
    wikiEditRequest: {
      async findUnique() { return { ...stored }; },
      async findFirst() { return null; },
      async updateMany(args: { where: { status: string }; data: Record<string, unknown> }) {
        if (stored.status !== args.where.status) return { count: 0 };
        Object.assign(stored, args.data);
        return { count: 1 };
      }
    }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 99n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;
  const service = new WikiEditRequestService(prisma, profiles, permissions, {} as WikiEditService);

  const updated = await service.update(session, '40', { baseRevisionId: '30', contentRaw: 'rebased', editSummary: 'rebased summary', isMinor: true });
  assert.equal(updated.status, 'pending');
  assert.equal(updated.baseRevisionId, '30');
  assert.equal(updated.proposedContent, 'rebased');

  assert.equal((await service.close(session, '40')).status, 'closed');
  assert.equal((await service.reopen(session, '40')).status, 'pending');
});

test('edit request diff is calculated from the exact base revision', async () => {
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiEditRequest: { async findUnique() { return request; } },
    wikiPageRevision: { async findUnique() { return { id: 30n, pageId: page.id, visibility: 'public', contentRaw: 'before' }; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;
  let compared: [string, string] | null = null;
  const edits = { diffText(left: string, right: string) { compared = [left, right]; return [{ type: 'removed' as const, line: left, leftLine: 1, rightLine: null }]; } } as unknown as WikiEditService;
  const service = new WikiEditRequestService(prisma, {} as WikiProfileService, permissions, edits);

  const diff = await service.diff('40');
  assert.deepEqual(compared, ['before', 'next']);
  assert.equal(diff.baseRevisionId, '30');
});
