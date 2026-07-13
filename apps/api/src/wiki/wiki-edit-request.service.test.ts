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
