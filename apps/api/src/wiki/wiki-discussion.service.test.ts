import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';
import { WikiDiscussionService } from './wiki-discussion.service';

const session = { userId: 'account-1' } as SessionPayload;
const page = {
  id: 10n,
  namespaceId: 1,
  spaceId: 2n,
  localPath: 'guide',
  slug: 'guide',
  title: 'Guide',
  displayTitle: 'Guide',
  currentRevisionId: 1n,
  pageType: 'article',
  protectionLevel: 'open',
  status: 'normal',
  createdBy: 20n,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z')
};
const thread = {
  id: 30n,
  pageId: page.id,
  title: '문서 토론',
  status: 'open',
  createdBy: 20n,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z')
};

function service(options: {
  thread?: typeof thread;
  comment?: { id: bigint; threadId: bigint; content: string; status: string; createdBy: bigint; createdAt: Date; updatedAt: Date | null };
  canManage?: boolean;
  onDiscuss?: () => void;
} = {}) {
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: {
      async findUnique() { return options.thread ?? thread; },
      async update() { return options.thread ?? thread; }
    },
    wikiDiscussionComment: {
      async findUnique() { return options.comment ?? null; },
      async findMany() { return []; },
      async count() { return 0; },
      async update() { return options.comment; }
    },
    wikiProfile: {
      async findMany() { return [{ id: 20n, displayName: '테스터' }]; }
    }
  };
  const profiles = {
    async ensureWikiProfile() { return { id: 20n }; }
  } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: session.userId, profileId: 20n }; },
    async assertCanDiscussPage() { options.onDiscuss?.(); },
    async canManagePage() { return options.canManage ?? false; },
    async assertCanReadPage() {}
  } as unknown as WikiPermissionService;
  return new WikiDiscussionService(store as unknown as PrismaService, profiles, permissions);
}

test('closed discussion rejects new comments before writing', async () => {
  const discussions = service({ thread: { ...thread, status: 'closed' } });
  await assert.rejects(
    discussions.addComment(session, thread.id.toString(), { content: 'reply' }),
    BadRequestException
  );
});

test('adding a comment checks the page discuss permission', async () => {
  let checked = false;
  const discussions = service({ onDiscuss: () => { checked = true; } });

  await assert.rejects(
    discussions.addComment(session, thread.id.toString(), { content: '' }),
    BadRequestException
  );
  assert.equal(checked, true);
});

test('non-owner without page management cannot close a discussion', async () => {
  const discussions = service({ thread: { ...thread, createdBy: 99n }, canManage: false });
  await assert.rejects(
    discussions.setThreadStatus(session, thread.id.toString(), 'closed'),
    ForbiddenException
  );
});

test('non-author without page management cannot delete another comment', async () => {
  const discussions = service({
    comment: {
      id: 40n,
      threadId: thread.id,
      content: 'comment',
      status: 'normal',
      createdBy: 99n,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: null
    },
    canManage: false
  });
  await assert.rejects(
    discussions.deleteComment(session, thread.id.toString(), '40'),
    ForbiddenException
  );
});

test('deleted discussion comments do not expose their former content', async () => {
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiDiscussionComment: {
      async count() { return 1; },
      async findMany() {
        return [{
          id: 40n, threadId: thread.id, content: 'removed secret', status: 'deleted', createdBy: 20n,
          createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z')
        }];
      }
    },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } }
  };
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    permissions
  );

  const result = await discussions.getThread(thread.id.toString());
  assert.equal(result.comments[0]?.content, null);
  assert.equal(result.comments[0]?.status, 'deleted');
});

test('recent discussion cursors fail closed when tampered', async () => {
  const discussions = service();
  await assert.rejects(discussions.listRecent(null, 'not-a-valid-cursor'), BadRequestException);
});

test('focused comment windows include the requested comment', async () => {
  let commentWhere: unknown;
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiDiscussionComment: {
      async findUnique() { return { threadId: thread.id }; },
      async count() { return 1; },
      async findMany(args: { where: unknown }) {
        commentWhere = args.where;
        return [{ id: 40n, threadId: thread.id, content: 'target', status: 'normal', createdBy: 20n, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: null }];
      }
    },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } }
  };
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    { async assertCanReadPage() {} } as unknown as WikiPermissionService
  );

  const result = await discussions.getThread(thread.id.toString(), null, undefined, 100, '40');
  assert.deepEqual(commentWhere, { threadId: thread.id, id: { lte: 40n } });
  assert.equal(result.comments[0]?.id, '40');
});
