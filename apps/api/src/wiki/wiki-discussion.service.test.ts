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
  pinnedCommentId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z')
};

function service(options: {
  thread?: typeof thread;
  comment?: { id: bigint; threadId: bigint; content: string; status: string; createdBy: bigint; createdAt: Date; updatedAt: Date | null };
  canManage?: boolean;
  onDiscuss?: () => void;
  onThreadUpdate?: (args: unknown) => void;
  onCommentUpdate?: (args: unknown) => void;
  onModerationCreate?: (args: unknown) => void;
} = {}) {
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: {
      async findUnique() { return options.thread ?? thread; },
      async update(args: unknown) { options.onThreadUpdate?.(args); return options.thread ?? thread; }
    },
    wikiDiscussionComment: {
      async findUnique() { return options.comment ?? null; },
      async findMany() { return []; },
      async count() { return 0; },
      async update(args: unknown) { options.onCommentUpdate?.(args); return options.comment; }
    },
    wikiDiscussionModerationEvent: {
      async create(args: unknown) { options.onModerationCreate?.(args); return args; }
    },
    wikiDiscussionSubscription: { async findUnique() { return null; } },
    wikiProfile: {
      async findMany() { return [{ id: 20n, displayName: '테스터' }]; }
    },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(store); }
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

test('thread author without page management cannot move or delete the whole discussion', async () => {
  const discussions = service({ canManage: false });
  await assert.rejects(
    discussions.moveThread(session, thread.id.toString(), '11', 'wrong page'),
    ForbiddenException
  );
  await assert.rejects(
    discussions.deleteThread(session, thread.id.toString(), 'remove thread'),
    ForbiddenException
  );
});

test('page manager soft-deletes a discussion without erasing its comments', async () => {
  let update: unknown;
  const discussions = service({ canManage: true, onThreadUpdate: (args) => { update = args; } });

  const result = await discussions.deleteThread(session, thread.id.toString(), 'duplicate');

  assert.deepEqual(result, { deleted: true, threadId: '30' });
  const mutation = update as { where: { id: bigint }; data: { status: string; pinnedCommentId: bigint | null; updatedAt: Date } };
  assert.equal(mutation.where.id, 30n);
  assert.equal(mutation.data.status, 'deleted');
  assert.equal(mutation.data.pinnedCommentId, null);
  assert.ok(mutation.data.updatedAt instanceof Date);
});

test('comment raw returns exact source only after the page read check', async () => {
  let readable = false;
  const rawComment = {
    id: 40n, threadId: thread.id, content: '원문 **그대로**', status: 'normal', createdBy: 20n,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: null
  };
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiDiscussionComment: { async findUnique() { return rawComment; } }
  };
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    { async assertCanReadPage() { readable = true; } } as unknown as WikiPermissionService
  );

  assert.equal(await discussions.getCommentRaw('30', '40', null), '원문 **그대로**');
  assert.equal(readable, true);
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

test('hidden discussion comments mask content for readers but remain visible to page managers', async () => {
  const hiddenComment = {
    id: 40n, threadId: thread.id, content: 'moderation evidence', status: 'hidden', createdBy: 20n,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z')
  };
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiDiscussionComment: { async count() { return 1; }, async findMany() { return [hiddenComment]; } },
    wikiDiscussionSubscription: { async findUnique() { return null; } },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } }
  };
  const profiles = { async ensureWikiProfile() { return { id: 20n }; } } as unknown as WikiProfileService;
  const readerPermissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;
  const managerPermissions = {
    async assertCanReadPage() {},
    actorFromSession() { return { accountId: session.userId, profileId: 20n }; },
    async canManagePage() { return true; }
  } as unknown as WikiPermissionService;

  const reader = await new WikiDiscussionService(store as unknown as PrismaService, profiles, readerPermissions).getThread('30');
  const manager = await new WikiDiscussionService(store as unknown as PrismaService, profiles, managerPermissions).getThread('30', session);

  assert.equal(reader.comments[0]?.content, null);
  assert.equal(reader.comments[0]?.canChangeVisibility, false);
  assert.equal(manager.comments[0]?.content, 'moderation evidence');
  assert.equal(manager.comments[0]?.canChangeVisibility, true);
});

test('page manager hides a pinned comment and appends moderation history atomically', async () => {
  const hiddenTarget = {
    id: 40n, threadId: thread.id, content: 'evidence', status: 'normal', createdBy: 99n,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: null
  };
  let commentUpdate: unknown;
  let threadUpdate: unknown;
  let moderationCreate: unknown;
  const discussions = service({
    thread: { ...thread, pinnedCommentId: 40n },
    comment: hiddenTarget,
    canManage: true,
    onCommentUpdate: (args) => { commentUpdate = args; },
    onThreadUpdate: (args) => { threadUpdate = args; },
    onModerationCreate: (args) => { moderationCreate = args; }
  });

  await discussions.setCommentVisibility(session, '30', '40', 'hidden', '개인정보 노출');

  assert.equal((commentUpdate as { data: { status: string } }).data.status, 'hidden');
  assert.equal((threadUpdate as { data: { pinnedCommentId: bigint | null } }).data.pinnedCommentId, null);
  const event = (moderationCreate as { data: { action: string; reason: string; commentId: bigint } }).data;
  assert.deepEqual([event.action, event.reason, event.commentId], ['hide', '개인정보 노출', 40n]);
});

test('hidden comment raw source is available only to a page manager', async () => {
  const hiddenComment = {
    id: 40n, threadId: thread.id, content: 'preserved source', status: 'hidden', createdBy: 20n,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z')
  };
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiDiscussionComment: { async findUnique() { return hiddenComment; } }
  };
  const profiles = { async ensureWikiProfile() { return { id: 20n }; } } as unknown as WikiProfileService;
  const permissions = {
    async assertCanReadPage() {},
    actorFromSession() { return { accountId: session.userId, profileId: 20n }; },
    async canManagePage() { return true; }
  } as unknown as WikiPermissionService;
  const discussions = new WikiDiscussionService(store as unknown as PrismaService, profiles, permissions);

  await assert.rejects(discussions.getCommentRaw('30', '40', null));
  assert.equal(await discussions.getCommentRaw('30', '40', session), 'preserved source');
});

test('recent discussion cursors fail closed when tampered', async () => {
  const discussions = service();
  await assert.rejects(discussions.listRecent(null, 'not-a-valid-cursor'), BadRequestException);
});

test('recent server discussions deep-link through the canonical tool route', async () => {
  const serverPage = { ...page, namespaceId: 2, spaceId: 9n, localPath: 'luna/API/requests', title: 'luna/API/requests' };
  const store = {
    wikiDiscussionThread: { async findMany() { return [{ ...thread, pageId: serverPage.id }]; } },
    wikiPage: { async findMany() { return [serverPage]; } },
    wikiNamespace: { async findMany() { return [{ id: 2, code: 'server' }]; } },
    serverWiki: { async findMany() { return [{ spaceId: 9n, slug: 'luna' }]; } },
    wikiDiscussionComment: { async groupBy() { return [{ threadId: thread.id, _count: { _all: 1 } }]; } },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } }
  };
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    { async assertCanReadPage() {} } as unknown as WikiPermissionService
  );
  const result = await discussions.listRecent(null, undefined, 30);
  assert.equal(
    result.items[0]?.discussionHref,
    '/server/luna/_tools/discuss/API/requests?thread=30'
  );
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

test('pinned discussion comment is included ahead of the current comment window', async () => {
  const pinnedThread = { ...thread, pinnedCommentId: 41n };
  const makeComment = (id: bigint, content: string) => ({ id, threadId: thread.id, content, status: 'normal', createdBy: 20n, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: null });
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: { async findUnique() { return pinnedThread; } },
    wikiDiscussionComment: {
      async findUnique() { return makeComment(41n, 'pinned'); },
      async count() { return 2; },
      async findMany() { return [makeComment(50n, 'latest')]; }
    },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } }
  };
  const discussions = new WikiDiscussionService(store as unknown as PrismaService, {} as WikiProfileService, { async assertCanReadPage() {} } as unknown as WikiPermissionService);
  const result = await discussions.getThread(thread.id.toString());
  assert.deepEqual(result.comments.map((comment) => comment.id), ['41', '50']);
  assert.equal(result.comments[0]?.pinned, true);
});
