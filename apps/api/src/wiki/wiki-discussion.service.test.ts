import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';
import { WikiDiscussionService } from './wiki-discussion.service';
import type { WikiDiscussionLiveService } from './wiki-discussion-live.service';

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
  canCreateThread?: boolean;
  onCreateThread?: () => void;
  onWriteThreadComment?: () => void;
  onThreadUpdate?: (args: unknown) => void;
  onCommentUpdate?: (args: unknown) => void;
  onSystemCreate?: (args: unknown) => void;
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
      async create(args: unknown) { options.onSystemCreate?.(args); return args; },
      async update(args: unknown) { options.onCommentUpdate?.(args); return options.comment; }
    },
    wikiDiscussionModerationEvent: {
      async findMany() { return []; },
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
    async assertCanDiscussPage() { options.onWriteThreadComment?.(); },
    async assertCanCreateThread() {
      options.onCreateThread?.();
      if (options.canCreateThread === false) throw new ForbiddenException('new threads disabled');
    },
    async assertCanWriteThreadComment() { options.onWriteThreadComment?.(); },
    async canManagePage() { return options.canManage ?? false; },
    async assertCanReadPage() {},
    async assertCanReadThread() {}
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

test('paused discussion rejects new comments with a distinct state error', async () => {
  const discussions = service({ thread: { ...thread, status: 'paused' } });
  await assert.rejects(
    discussions.addComment(session, thread.id.toString(), { content: 'reply' }),
    (error: unknown) => error instanceof BadRequestException && error.message === 'Wiki discussion thread is paused.'
  );
});

test('adding a comment checks the write-thread-comment permission', async () => {
  let checked = false;
  const discussions = service({ onWriteThreadComment: () => { checked = true; } });

  await assert.rejects(
    discussions.addComment(session, thread.id.toString(), { content: '' }),
    BadRequestException
  );
  assert.equal(checked, true);
});

test('creating a thread checks the create-thread permission', async () => {
  let checked = false;
  const discussions = service({ onCreateThread: () => { checked = true; } });

  await assert.rejects(
    discussions.createThread(session, page.id.toString(), { title: '', content: '' }),
    BadRequestException
  );
  assert.equal(checked, true);
});

test('page discussion capabilities expose create-thread ACL without changing the thread list contract', async () => {
  assert.deepEqual(await service({ canCreateThread: true }).getPageDiscussionPermissions(page.id.toString(), session), {
    canCreateThread: true
  });
  assert.deepEqual(await service({ canCreateThread: false }).getPageDiscussionPermissions(page.id.toString(), session), {
    canCreateThread: false
  });
});

test('non-owner without page management cannot close a discussion', async () => {
  const discussions = service({ thread: { ...thread, createdBy: 99n }, canManage: false });
  await assert.rejects(
    discussions.setThreadStatus(session, thread.id.toString(), 'closed'),
    ForbiddenException
  );
});

test('only page managers can pause or resume a paused discussion', async () => {
  await assert.rejects(
    service({ canManage: false }).setThreadStatus(session, thread.id.toString(), 'paused'),
    ForbiddenException
  );
  await assert.rejects(
    service({ thread: { ...thread, status: 'paused' }, canManage: false }).setThreadStatus(session, thread.id.toString(), 'open'),
    ForbiddenException
  );

  let update: unknown;
  let event: unknown;
  await service({ canManage: true, onThreadUpdate: (args) => { update = args; }, onSystemCreate: (args) => { event = args; } })
    .setThreadStatus(session, thread.id.toString(), 'paused');
  assert.equal((update as { data: { status: string } }).data.status, 'paused');
  assert.deepEqual((event as { data: unknown }).data, {
    threadId: thread.id, content: '', status: 'normal', entryType: 'system', eventType: 'status_change',
    eventBefore: 'open', eventAfter: 'paused', createdBy: 20n,
    createdAt: (event as { data: { createdAt: Date } }).data.createdAt
  });
});

test('topic changes append the previous and next title to the system timeline', async () => {
  let event: unknown;
  await service({ onSystemCreate: (args) => { event = args; } })
    .updateThreadTopic(session, thread.id.toString(), '새 토론 주제');

  assert.deepEqual((event as { data: unknown }).data, {
    threadId: thread.id, content: '', status: 'normal', entryType: 'system', eventType: 'topic_change',
    eventBefore: thread.title, eventAfter: '새 토론 주제', createdBy: 20n,
    createdAt: (event as { data: { createdAt: Date } }).data.createdAt
  });
});

test('pin changes append only a normal user comment to the system timeline', async () => {
  const pinTarget = {
    id: 40n, threadId: thread.id, content: '고정할 댓글', status: 'normal', createdBy: 99n,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: null
  };
  let event: unknown;
  await service({ comment: pinTarget, onSystemCreate: (args) => { event = args; } })
    .setPinnedComment(session, thread.id.toString(), pinTarget.id.toString());

  assert.deepEqual((event as { data: unknown }).data, {
    threadId: thread.id, content: '', status: 'normal', entryType: 'system', eventType: 'pin_change',
    eventBefore: null, eventAfter: pinTarget.id.toString(), createdBy: 20n,
    createdAt: (event as { data: { createdAt: Date } }).data.createdAt
  });
});

test('page move timeline redacts a page name the reader cannot access', async () => {
  const privatePage = { ...page, id: 99n, title: 'Secret', displayTitle: '비공개 작전' };
  const event = {
    id: 41n, threadId: thread.id, content: '', status: 'normal', entryType: 'system', eventType: 'page_move',
    eventBefore: privatePage.id.toString(), eventAfter: page.id.toString(), createdBy: 20n,
    createdAt: new Date('2026-01-02T00:00:00Z'), updatedAt: null
  };
  const store = {
    wikiPage: {
      async findUnique() { return page; },
      async findMany() { return [privatePage, page]; }
    },
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiDiscussionComment: { async findMany() { return [event]; }, async count() { return 0; } },
    wikiDiscussionSubscription: { async findUnique() { return null; } },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } }
  };
  const permissions = {
    async assertCanReadPage({ page: checked }: { page: { id: bigint } }) {
      if (checked.id === privatePage.id) throw new ForbiddenException();
    }
  } as unknown as WikiPermissionService;
  const result = await new WikiDiscussionService(store as unknown as PrismaService, {} as WikiProfileService, permissions).getThread('30');
  assert.equal(result.comments[0]?.content, null);
  assert.deepEqual(result.comments[0]?.systemEvent, {
    type: 'page_move', before: null, after: 'Guide', beforeRedacted: true, afterRedacted: false
  });
  assert.equal(JSON.stringify(result).includes('비공개 작전'), false);
  assert.equal(JSON.stringify(result).includes('99'), false);
});

test('system timeline entries cannot be read through the raw comment endpoint', async () => {
  const systemEntry = {
    id: 41n, threadId: thread.id, content: '', status: 'normal', entryType: 'system', eventType: 'topic_change',
    eventBefore: '이전', eventAfter: '이후', createdBy: 20n, createdAt: new Date(), updatedAt: null
  };
  await assert.rejects(service({ comment: systemEntry }).getCommentRaw('30', '41'), NotFoundException);
});

test('thread author cannot overwrite a concurrent manager pause', async () => {
  let threadReads = 0;
  let updated = false;
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: {
      async findUnique() {
        threadReads += 1;
        return threadReads === 1 ? thread : { ...thread, status: 'paused' };
      },
      async update() { updated = true; return thread; }
    },
    async $queryRaw() { return []; },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(store); }
  };
  const profiles = { async ensureWikiProfile() { return { id: 20n }; } } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: session.userId, profileId: 20n }; },
    async canManagePage() { return false; }
  } as unknown as WikiPermissionService;
  const discussions = new WikiDiscussionService(store as unknown as PrismaService, profiles, permissions);

  await assert.rejects(
    discussions.setThreadStatus(session, thread.id.toString(), 'closed'),
    ForbiddenException
  );
  assert.equal(updated, false);
  assert.equal(threadReads, 2);
});

test('thread authors retain the existing close and reopen permission', async () => {
  let update: unknown;
  await service({ canManage: false, onThreadUpdate: (args) => { update = args; } })
    .setThreadStatus(session, thread.id.toString(), 'closed');
  assert.equal((update as { data: { status: string } }).data.status, 'closed');

  await service({ thread: { ...thread, status: 'closed' }, canManage: false, onThreadUpdate: (args) => { update = args; } })
    .setThreadStatus(session, thread.id.toString(), 'open');
  assert.equal((update as { data: { status: string } }).data.status, 'open');
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

test('comment author cannot erase content after a moderator hides it', async () => {
  let updated = false;
  const discussions = service({
    comment: {
      id: 40n,
      threadId: thread.id,
      content: 'moderation evidence',
      status: 'hidden',
      createdBy: 20n,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: null
    },
    canManage: false,
    onCommentUpdate: () => { updated = true; }
  });

  await assert.rejects(
    discussions.deleteComment(session, thread.id.toString(), '40'),
    ForbiddenException
  );
  assert.equal(updated, false);
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
  assert.equal(result.comments[0]?.contentHtml, null);
  assert.equal(result.comments[0]?.status, 'hidden');
  assert.equal(result.comments[0]?.createdBy, null);
  assert.equal(result.comments[0]?.createdByName, '비공개 사용자');
  assert.equal(result.comments[0]?.createdAt, null);
  assert.doesNotMatch(JSON.stringify(result.comments[0]), /removed secret|테스터|2026-01-01/);
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
    wikiDiscussionModerationEvent: { async findMany() { return []; } },
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
  assert.equal(reader.comments[0]?.contentHtml, null);
  assert.equal(reader.comments[0]?.createdBy, null);
  assert.equal(reader.comments[0]?.createdAt, null);
  assert.doesNotMatch(JSON.stringify(reader.comments[0]), /moderation evidence|테스터|2026-01-01/);
  assert.equal(reader.comments[0]?.canChangeVisibility, false);
  assert.equal(manager.comments[0]?.content, 'moderation evidence');
  assert.match(manager.comments[0]?.contentHtml ?? '', /moderation evidence/u);
  assert.equal(manager.comments[0]?.createdBy, '20');
  assert.equal(manager.comments[0]?.canChangeVisibility, true);
});

test('discussion comments expose sanitized restricted NamuMark with server-wiki links and validated mentions', async () => {
  const serverPage = { ...page, namespaceId: 2, spaceId: 9n, localPath: 'luna/가이드/설치' };
  const comment = {
    id: 40n,
    threadId: thread.id,
    content: [
      "'''안내''' @Alice",
      '||항목||값||',
      '{{{@Alice}}}',
      '[[../규칙]]',
      '[[include(비밀 문서)]]',
      '[youtube(dQw4w9WgXcQ)]',
    ].join('\n'),
    status: 'normal',
    entryType: 'comment',
    createdBy: 20n,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: null,
  };
  const store = {
    wikiPage: { async findUnique() { return serverPage; } },
    wikiNamespace: { async findUnique() { return { code: 'server' }; } },
    serverWiki: { async findUnique() { return { slug: 'luna', status: 'active' }; } },
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiDiscussionComment: { async count() { return 1; }, async findMany() { return [comment]; } },
    wikiDiscussionSubscription: { async findUnique() { return null; } },
    wikiProfile: {
      async findMany() {
        return [
          { id: 20n, username: 'Author', displayName: '작성자', status: 'active' },
          { id: 21n, username: 'Alice', displayName: '앨리스', status: 'active' },
        ];
      },
    },
  };
  const result = await new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    { async assertCanReadPage() {} } as unknown as WikiPermissionService,
  ).getThread(thread.id.toString());
  const rendered = result.comments[0];

  assert.equal(rendered?.content, comment.content);
  assert.match(rendered?.contentHtml ?? '', /<strong>안내<\/strong>/u);
  assert.match(rendered?.contentHtml ?? '', /<table class="component-table wiki-table"/u);
  assert.match(rendered?.contentHtml ?? '', /href="\/server\/luna\/%EA%B0%80%EC%9D%B4%EB%93%9C\/%EA%B7%9C%EC%B9%99"/u);
  assert.equal((rendered?.contentHtml?.match(/href="\/user\/Alice"/gu) ?? []).length, 1);
  assert.match(rendered?.contentHtml ?? '', /<code>@Alice<\/code>/u);
  assert.equal(rendered?.contentHtml?.includes('wiki-transclusion'), false);
  assert.equal(rendered?.contentHtml?.includes('<iframe'), false);
  assert.deepEqual(rendered?.mentions, [{ username: 'Alice', profileId: '21', start: 9, end: 15 }]);
});

test('comment moderation history is bounded and visible only to page managers', async () => {
  const moderatedComment = {
    id: 40n, threadId: thread.id, content: '복구된 댓글', status: 'normal', createdBy: 20n,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-03T00:00:00Z')
  };
  const moderationEvents = [
    {
      id: 1552n, threadId: thread.id, commentId: moderatedComment.id, actorProfileId: 21n,
      action: 'restore', reason: '개인정보를 제거한 뒤 복구', createdAt: new Date('2026-01-03T00:00:00Z')
    },
    {
      id: 1551n, threadId: thread.id, commentId: moderatedComment.id, actorProfileId: 21n,
      action: 'hide', reason: '개인정보 노출', createdAt: new Date('2026-01-02T00:00:00Z')
    },
    ...Array.from({ length: 499 }, (_, index) => ({
      id: BigInt(1550 - index), threadId: thread.id, commentId: moderatedComment.id, actorProfileId: 21n,
      action: index % 2 === 0 ? 'restore' : 'hide', reason: `이전 조정 ${index + 1}`,
      createdAt: new Date('2026-01-01T00:00:00Z')
    }))
  ];
  let moderationQueries = 0;
  let moderationQuery: unknown;
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiDiscussionComment: { async count() { return 1; }, async findMany() { return [moderatedComment]; } },
    wikiDiscussionModerationEvent: {
      async findMany(args: unknown) {
        moderationQueries += 1;
        moderationQuery = args;
        return moderationEvents;
      }
    },
    wikiDiscussionSubscription: { async findUnique() { return null; } },
    wikiProfile: {
      async findMany() {
        return [
          { id: 20n, displayName: '작성자' },
          { id: 21n, displayName: '조정자' }
        ];
      }
    }
  };
  const profiles = { async ensureWikiProfile() { return { id: 20n }; } } as unknown as WikiProfileService;
  const readerPermissions = {
    async assertCanReadPage() {},
    actorFromSession() { return { accountId: session.userId, profileId: 20n }; },
    async canManagePage() { return false; }
  } as unknown as WikiPermissionService;
  const managerPermissions = {
    async assertCanReadPage() {},
    actorFromSession() { return { accountId: session.userId, profileId: 20n }; },
    async canManagePage() { return true; }
  } as unknown as WikiPermissionService;

  const reader = await new WikiDiscussionService(store as unknown as PrismaService, profiles, readerPermissions).getThread('30', session);
  assert.equal(moderationQueries, 0);
  assert.deepEqual(reader.comments[0]?.moderationHistory, []);
  assert.equal(reader.moderationHistoryTruncated, false);

  const manager = await new WikiDiscussionService(store as unknown as PrismaService, profiles, managerPermissions).getThread('30', session);
  assert.equal(moderationQueries, 1);
  assert.deepEqual(moderationQuery, {
    where: { commentId: { in: [40n] }, action: { in: ['hide', 'restore'] } },
    orderBy: [{ id: 'desc' }],
    take: 501
  });
  assert.equal(manager.comments[0]?.moderationHistory.length, 500);
  assert.deepEqual(manager.comments[0]?.moderationHistory.slice(0, 2), [
    {
      id: '1552', action: 'restore', reason: '개인정보를 제거한 뒤 복구', actorProfileId: '21',
      actorProfileName: '조정자', createdAt: '2026-01-03T00:00:00.000Z'
    },
    {
      id: '1551', action: 'hide', reason: '개인정보 노출', actorProfileId: '21',
      actorProfileName: '조정자', createdAt: '2026-01-02T00:00:00.000Z'
    }
  ]);
  assert.equal(manager.moderationHistoryTruncated, true);
});

test('page manager hides a pinned comment and appends moderation history atomically', async () => {
  const hiddenTarget = {
    id: 40n, threadId: thread.id, content: 'evidence', status: 'normal', createdBy: 99n,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: null
  };
  let commentUpdate: unknown;
  let threadUpdate: unknown;
  let moderationCreate: unknown;
  let systemCreate: unknown;
  const discussions = service({
    thread: { ...thread, pinnedCommentId: 40n },
    comment: hiddenTarget,
    canManage: true,
    onCommentUpdate: (args) => { commentUpdate = args; },
    onThreadUpdate: (args) => { threadUpdate = args; },
    onSystemCreate: (args) => { systemCreate = args; },
    onModerationCreate: (args) => { moderationCreate = args; }
  });

  await discussions.setCommentVisibility(session, '30', '40', 'hidden', '개인정보 노출');

  assert.equal((commentUpdate as { data: { status: string } }).data.status, 'hidden');
  assert.equal((threadUpdate as { data: { pinnedCommentId: bigint | null } }).data.pinnedCommentId, null);
  assert.deepEqual((systemCreate as { data: unknown }).data, {
    threadId: thread.id, content: '', status: 'normal', entryType: 'system', eventType: 'pin_change',
    eventBefore: hiddenTarget.id.toString(), eventAfter: null, createdBy: 20n,
    createdAt: (systemCreate as { data: { createdAt: Date } }).data.createdAt
  });
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
  await assert.rejects(discussions.listRecent(null, { cursor: 'not-a-valid-cursor' }), BadRequestException);
});

test('server recent discussions resolve the tenant and filter candidates by its immutable space', async () => {
  let rawQuery: Prisma.Sql | null = null;
  const store = {
    serverWiki: {
      async findFirst() { return { id: 50n, spaceId: 40n }; },
    },
    async $queryRaw(query: Prisma.Sql) { rawQuery = query; return []; },
  } as unknown as PrismaService;
  const discussions = new WikiDiscussionService(store, {} as WikiProfileService, {} as WikiPermissionService);

  assert.deepEqual(await discussions.listRecent(null, { serverSlug: 'alpha', status: 'active' }), {
    items: [], nextCursor: null,
  });
  assert.ok(rawQuery);
  assert.equal(rawQuery!.strings.join('?').includes('p.space_id ='), true);
  assert.equal(rawQuery!.values.includes(40n), true);
});

test('global recent discussions filter status, support both keyset orders, and bind cursors to filters', async () => {
  const rows = [
    { ...thread, id: 31n, status: 'closed', updatedAt: new Date('2026-07-18T03:00:00Z') },
    { ...thread, id: 30n, status: 'paused', updatedAt: new Date('2026-07-18T02:00:00Z') },
    { ...thread, id: 29n, status: 'open', updatedAt: new Date('2026-07-18T01:00:00Z') },
  ];
  const queries: Array<{ where: Prisma.WikiDiscussionThreadWhereInput; orderBy: unknown }> = [];
  const store = {
    wikiDiscussionThread: {
      async findMany(args: { where: Prisma.WikiDiscussionThreadWhereInput; orderBy: Array<{ updatedAt?: 'asc' | 'desc'; id?: 'asc' | 'desc' }>; take: number }) {
        queries.push({ where: args.where, orderBy: args.orderBy });
        const status = args.where.status as string | { in?: string[]; not?: string };
        let result = rows.filter((row) => typeof status === 'string'
          ? row.status === status
          : status.in ? status.in.includes(row.status) : row.status !== status.not);
        const idConstraint = (args.where.OR as Array<{ id?: { lt?: bigint; gt?: bigint } }> | undefined)
          ?.find((entry) => entry.id)?.id;
        if (idConstraint?.lt !== undefined) {
          result = result.filter((row) => row.id < idConstraint.lt!);
        } else if (idConstraint?.gt !== undefined) {
          result = result.filter((row) => row.id > idConstraint.gt!);
        }
        const descending = args.orderBy[0]?.updatedAt === 'desc';
        result = [...result].sort((left, right) => descending ? Number(right.id - left.id) : Number(left.id - right.id));
        return result.slice(0, args.take);
      },
    },
    wikiPage: { async findMany() { return [page]; } },
    wikiPageRevision: { async findMany() { return [{ id: page.currentRevisionId }]; } },
    wikiNamespace: { async findMany() { return [{ id: page.namespaceId, code: 'main' }]; } },
    serverWiki: { async findMany() { return []; } },
    wikiDiscussionComment: { async groupBy() { return []; } },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } },
  };
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    { async filterReadableThreads<T>({ items }: { items: T[] }) { return items; } } as unknown as WikiPermissionService,
  );

  const newest = await discussions.listRecent(null, { limit: 1, status: 'active', sort: 'newest' });
  assert.deepEqual(newest.items.map((item) => item.id), ['30']);
  assert.ok(newest.nextCursor);
  assert.deepEqual(queries[0]?.orderBy, [{ updatedAt: 'desc' }, { id: 'desc' }]);
  assert.deepEqual(queries[0]?.where.status, { in: ['open', 'paused'] });
  await assert.rejects(
    discussions.listRecent(null, { cursor: newest.nextCursor ?? undefined, limit: 1, status: 'closed', sort: 'newest' }),
    BadRequestException,
  );
  await assert.rejects(
    discussions.listRecent(null, { cursor: newest.nextCursor ?? undefined, limit: 1, status: 'active', sort: 'oldest' }),
    BadRequestException,
  );

  const oldest = await discussions.listRecent(null, { limit: 1, status: 'all', sort: 'oldest' });
  assert.deepEqual(oldest.items.map((item) => item.id), ['29']);
  assert.deepEqual(queries.at(-1)?.orderBy, [{ updatedAt: 'asc' }, { id: 'asc' }]);
});

test('global recent discussions scan past ACL-hidden batches without revealing them', async () => {
  const updatedAt = new Date('2026-07-18T03:00:00Z');
  const rows = Array.from({ length: 61 }, (_, index) => ({ ...thread, id: BigInt(100 - index), updatedAt }));
  let threadQueries = 0;
  const store = {
    wikiDiscussionThread: {
      async findMany(args: { where: { OR?: Array<{ id?: { lt?: bigint } }> }; take: number }) {
        threadQueries += 1;
        const cursorId = args.where.OR?.find((entry) => entry.id?.lt)?.id?.lt;
        return (cursorId === undefined ? rows : rows.filter((row) => row.id < cursorId)).slice(0, args.take);
      },
    },
    wikiPage: { async findMany() { return [page]; } },
    wikiPageRevision: { async findMany() { return [{ id: page.currentRevisionId }]; } },
    wikiNamespace: { async findMany() { return [{ id: page.namespaceId, code: 'main' }]; } },
    serverWiki: { async findMany() { return []; } },
    wikiDiscussionComment: { async groupBy() { return []; } },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } },
  };
  const permissions = {
    async filterReadableThreads<T extends { thread: { id: bigint } }>({ items }: { items: T[] }) {
      return items.filter((item) => item.thread.id <= 50n);
    },
  } as unknown as WikiPermissionService;
  const discussions = new WikiDiscussionService(store as unknown as PrismaService, {} as WikiProfileService, permissions);

  const result = await discussions.listRecent(null, { limit: 10, status: 'all', sort: 'newest' });
  assert.deepEqual(result.items.map((item) => item.id), ['50', '49', '48', '47', '46', '45', '44', '43', '42', '41']);
  assert.equal(result.items.some((item) => BigInt(item.id) > 50n), false);
  assert.ok(result.nextCursor);
  assert.equal(threadQueries, 2);
});

test('page discussion lists paginate beyond the legacy one-hundred thread window', async () => {
  const updatedAt = new Date('2026-07-13T00:00:00Z');
  const rows = Array.from({ length: 31 }, (_, index) => ({ ...thread, id: BigInt(100 - index), updatedAt }));
  const queries: Array<{ where: unknown; orderBy: unknown; take?: number; select?: unknown }> = [];
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: {
      async findMany(args: { where: unknown; orderBy: unknown; take?: number; select?: unknown }) {
        queries.push(args);
        const where = args.where as {
          status?: string | { in?: string[] };
          OR?: Array<{ updatedAt?: { lt?: Date }; id?: { lt?: bigint } }>;
        };
        let result = rows;
        const cursorId = where.OR?.find((entry) => entry.id?.lt)?.id?.lt;
        if (cursorId !== undefined) result = result.filter((row) => row.id < cursorId);
        if (typeof where.status === 'string') result = result.filter((row) => row.status === where.status);
        if (typeof where.status === 'object' && where.status.in) {
          result = result.filter((row) => where.status && typeof where.status === 'object' && where.status.in?.includes(row.status));
        }
        return result.slice(0, args.take);
      },
      async groupBy() {
        return [
          { status: 'open', _count: { _all: 1 } },
          { status: 'paused', _count: { _all: 2 } },
          { status: 'closed', _count: { _all: 3 } },
          { status: 'legacy', _count: { _all: 4 } }
        ];
      }
    },
    wikiDiscussionComment: { async groupBy() { return []; } },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } }
  };
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    { async assertCanReadPage() {} } as unknown as WikiPermissionService
  );

  const first = await discussions.listThreadsPage(page.id.toString(), null, undefined, 30);
  assert.equal(first.items.length, 30);
  assert.ok(first.nextCursor);

  const second = await discussions.listThreadsPage(page.id.toString(), null, first.nextCursor ?? undefined, 30);
  assert.deepEqual(second.items.map((item) => item.id), ['70']);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(second.statusCounts, { total: 31, open: 31, paused: 0, closed: 0 });
  assert.equal(second.statusCountsComplete, true);
  let pageQueries = queries.filter((query) => !query.select);
  assert.deepEqual(pageQueries[1]?.orderBy, [{ updatedAt: 'desc' }, { id: 'desc' }]);
  assert.equal(pageQueries[1]?.take, 50);
  const secondWhere = pageQueries[1]?.where as { pageId: bigint; status: unknown; OR: unknown };
  assert.equal(secondWhere.pageId, page.id);
  assert.deepEqual(secondWhere.status, { not: 'deleted' });
  assert.ok(secondWhere.OR);

  await discussions.listThreadsPage(page.id.toString(), null, undefined, 30, 'paused');
  pageQueries = queries.filter((query) => !query.select);
  assert.equal((pageQueries[2]?.where as { status: unknown }).status, 'paused');
});

test('page discussions evaluate public server wiki ACLs against the published release snapshot', async () => {
  const livePage = {
    ...page,
    namespaceId: 9,
    spaceId: 40n,
    localPath: 'luna/private-draft',
    slug: 'luna/private-draft',
    title: 'luna/private-draft',
    displayTitle: 'Private draft',
    currentRevisionId: 13n,
    protectionLevel: 'admin',
  };
  const releaseItem = {
    id: 80n,
    releaseId: 70n,
    serverWikiId: 50n,
    spaceId: 40n,
    namespaceId: 2,
    pageId: page.id,
    revisionId: 12n,
    localPath: 'luna/public-guide',
    slug: 'luna/public-guide',
    title: 'luna/public-guide',
    displayTitle: 'Public guide',
    pageType: 'article',
    protectionLevel: 'open',
    pageStatus: 'normal',
    createdBy: 20n,
    ownerProfileId: null,
    pageUpdatedAt: new Date('2026-07-18T00:00:00Z'),
  };
  const boundary = {
    serverWikiId: 50n,
    spaceId: 40n,
    currentReleaseId: 70n,
    currentReleaseVersion: 2,
    currentItem: releaseItem,
  };
  const checkedPages: Array<{ title: string; protectionLevel: string; currentRevisionId: bigint | null }> = [];
  let proofItem: typeof releaseItem | undefined;
  const store = {
    wikiPage: { async findUnique() { return livePage; } },
    wikiDiscussionThread: { async findMany() { return [thread]; } },
    wikiDiscussionComment: { async groupBy() { return []; } },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } },
  };
  const permissions = {
    async resolvePublishedPageBoundary() { return boundary; },
    async assertCanReadPage(input: {
      page: { title: string; protectionLevel: string; currentRevisionId: bigint | null };
      publicationProof?: { item: typeof releaseItem };
    }) {
      checkedPages.push(input.page);
      proofItem = input.publicationProof?.item;
    },
    async filterReadableThreads<T>({ items }: { items: T[] }) { return items; },
  } as unknown as WikiPermissionService;
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    permissions,
  );

  const result = await discussions.listThreads(page.id.toString(), null);

  assert.equal(result.length, 1);
  assert.equal(checkedPages[0]?.title, 'luna/public-guide');
  assert.equal(checkedPages[0]?.protectionLevel, 'open');
  assert.equal(checkedPages[0]?.currentRevisionId, 12n);
  assert.equal(proofItem, releaseItem);
});

test('discussion comment writes recheck the published page snapshot inside the transaction', async () => {
  const livePage = {
    ...page,
    spaceId: 40n,
    namespaceId: 9,
    title: 'luna/private-draft',
    localPath: 'luna/private-draft',
    protectionLevel: 'admin',
  };
  const releaseItem = {
    releaseId: 70n,
    serverWikiId: 50n,
    spaceId: 40n,
    namespaceId: 2,
    pageId: page.id,
    revisionId: 12n,
    localPath: 'luna/public-guide',
    slug: 'luna/public-guide',
    title: 'luna/public-guide',
    displayTitle: 'Public guide',
    pageType: 'article',
    protectionLevel: 'open',
    pageStatus: 'normal',
    createdBy: 20n,
    ownerProfileId: null,
    pageUpdatedAt: new Date('2026-07-18T00:00:00Z'),
  };
  const checkedTitles: string[] = [];
  const store = {
    wikiPage: { async findUnique() { return livePage; } },
    wikiDiscussionThread: {
      async findUnique() { return thread; },
      async update() { return thread; },
    },
    wikiDiscussionComment: {
      async create() { return { id: 31n }; },
    },
    wikiDiscussionSubscription: { async upsert() {} },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(store); },
  };
  const profiles = {
    async ensureWikiProfile() { return { id: 20n, status: 'active' }; },
  } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: session.userId, profileId: 20n, status: 'active' }; },
    async resolvePublishedPageBoundary() {
      return {
        serverWikiId: 50n,
        spaceId: 40n,
        currentReleaseId: 70n,
        currentReleaseVersion: 2,
        currentItem: releaseItem,
      };
    },
    async assertCanReadPage() {},
    async assertCanReadThread() {},
    async assertCanWriteThreadComment({ page: checked }: { page: { title: string } }) {
      checkedTitles.push(checked.title);
    },
  } as unknown as WikiPermissionService;
  const discussions = new WikiDiscussionService(store as unknown as PrismaService, profiles, permissions);
  discussions.getThread = async () => ({ id: thread.id.toString() }) as never;

  await discussions.addComment(session, thread.id.toString(), { content: 'released discussion reply' });

  assert.deepEqual(checkedTitles, ['luna/public-guide', 'luna/public-guide']);
});

test('discussion previews expose the first and latest comments without hidden or deleted content', async () => {
  const previewRows = [
    { id: 1n, threadId: 30n, contentPreview: '[vote(선호 버전,1.20,1.21)]', contentLength: 27n, pollQuestion: '선호 버전', status: 'normal', createdBy: 20n, createdAt: new Date('2026-01-01T00:00:00Z'), firstRank: 1n, recentRank: 2n, commentCount: 2n },
    { id: 3n, threadId: 30n, contentPreview: 'hidden secret', contentLength: 13n, status: 'hidden', createdBy: 21n, createdAt: new Date('2026-01-03T00:00:00Z'), firstRank: 3n, recentRank: 3n, commentCount: 5n },
    { id: 4n, threadId: 30n, contentPreview: 'deleted secret', contentLength: 14n, status: 'deleted', createdBy: 21n, createdAt: new Date('2026-01-04T00:00:00Z'), firstRank: 4n, recentRank: 2n, commentCount: 5n },
    { id: 5n, threadId: 30n, contentPreview: 'latest comment', contentLength: 14n, status: 'normal', createdBy: 20n, createdAt: new Date('2026-01-05T00:00:00Z'), firstRank: 2n, recentRank: 1n, commentCount: 2n },
  ];
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: { async findMany() { return [thread]; } },
    wikiDiscussionComment: { async groupBy() { throw new Error('preview must reuse window count'); } },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }, { id: 21n, displayName: '숨김 사용자' }]; } },
    async $queryRaw() { return previewRows; },
  };
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    { async assertCanReadPage() {} } as unknown as WikiPermissionService,
  );

  const result = await discussions.listThreadsPage('10', null, undefined, 30, 'all', true);
  assert.equal(result.items[0]?.commentCount, 2);
  assert.deepEqual(result.items[0]?.preview, {
    firstComment: {
      id: '1', status: 'normal', contentPreview: '설문: 선호 버전', truncated: false,
      createdBy: '20', createdByName: '테스터', createdAt: '2026-01-01T00:00:00.000Z',
    },
    recentComments: [
      { id: '5', status: 'normal', contentPreview: 'latest comment', truncated: false, createdBy: '20', createdByName: '테스터', createdAt: '2026-01-05T00:00:00.000Z' },
    ],
    omittedCommentCount: 0,
  });
  assert.doesNotMatch(JSON.stringify(result.items[0]?.preview), /hidden secret|deleted secret|숨김 사용자/);
  assert.doesNotMatch(JSON.stringify(result.items[0]?.preview), /\[vote/u);
});

test('active discussion filter includes open and paused but excludes closed threads', async () => {
  const queries: Array<{ where: unknown; select?: unknown }> = [];
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: {
      async findMany(args: { where: unknown; select?: unknown }) { queries.push(args); return []; },
      async groupBy() { return []; }
    },
    wikiDiscussionComment: { async groupBy() { return []; } },
    wikiProfile: { async findMany() { return []; } }
  };
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    { async assertCanReadPage() {} } as unknown as WikiPermissionService
  );

  const result = await discussions.listThreadsPage(page.id.toString(), null, undefined, 30, 'active');
  assert.deepEqual((queries.find((query) => !query.select)?.where as { status: unknown }).status, { in: ['open', 'paused'] });
  assert.deepEqual(result.statusCounts, { total: 0, open: 0, paused: 0, closed: 0 });
});

test('page discussion pagination bounds ACL overfetch and advances past denied rows', async () => {
  const updatedAt = new Date('2026-07-13T00:00:00Z');
  const rows = Array.from({ length: 51 }, (_, index) => ({ ...thread, id: BigInt(100 - index), updatedAt }));
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: {
      async findMany() { return rows; },
      async groupBy() { return [{ status: 'open', _count: { _all: 51 } }]; }
    },
    wikiDiscussionComment: { async groupBy() { return []; } },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } }
  };
  const permissions = {
    async assertCanReadPage() {},
    async filterReadableThreads({ items }: { items: Array<{ thread: typeof thread }> }) {
      return items.filter((item) => item.thread.id <= 90n);
    }
  } as unknown as WikiPermissionService;
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    permissions
  );

  const result = await discussions.listThreadsPage(page.id.toString(), null, undefined, 10);

  assert.deepEqual(result.items.map((item) => item.id), ['90', '89', '88', '87', '86', '85', '84', '83', '82', '81']);
  assert.ok(result.nextCursor);
  assert.deepEqual(result.statusCounts, { total: 41, open: 41, paused: 0, closed: 0 });
  assert.equal(result.statusCountsComplete, true);
});

test('page discussion pagination exhausts terminal ACL-denied batches without a false cursor', async () => {
  const updatedAt = new Date('2026-07-13T00:00:00Z');
  const rows = Array.from({ length: 120 }, (_, index) => ({ ...thread, id: BigInt(220 - index), updatedAt }));
  const pageQueries: Array<{ take: number }> = [];
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: {
      async findMany(args: {
        where: { OR?: Array<{ id?: { lt?: bigint } }> };
        take: number;
        select?: unknown;
      }) {
        if (args.select) return rows.slice(0, args.take);
        pageQueries.push(args);
        const cursorId = args.where.OR?.find((entry) => entry.id?.lt)?.id?.lt;
        const candidates = cursorId === undefined ? rows : rows.filter((row) => row.id < cursorId);
        return candidates.slice(0, args.take);
      }
    },
    wikiDiscussionComment: { async groupBy() { return []; } },
    wikiProfile: { async findMany() { return []; } }
  };
  const permissions = {
    async assertCanReadPage() {},
    async filterReadableThreads() { return []; }
  } as unknown as WikiPermissionService;
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    permissions
  );

  const result = await discussions.listThreadsPage(page.id.toString(), null, undefined, 10);

  assert.deepEqual(result.items, []);
  assert.equal(result.nextCursor, null);
  assert.ok(pageQueries.length > 1);
  assert.ok(pageQueries.every((query) => query.take <= 50));
});

test('page discussion pagination resumes after the ACL scan cap without duplicates or skips', async () => {
  const updatedAt = new Date('2026-07-13T00:00:00Z');
  const rows = Array.from({ length: 260 }, (_, index) => ({ ...thread, id: BigInt(400 - index), updatedAt }));
  const pageQueries: Array<{
    where: { OR?: Array<{ id?: { lt?: bigint } }> };
    take: number;
  }> = [];
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: {
      async findMany(args: {
        where: { OR?: Array<{ id?: { lt?: bigint } }> };
        take: number;
        select?: unknown;
      }) {
        const cursorId = args.where.OR?.find((entry) => entry.id?.lt)?.id?.lt;
        const candidates = cursorId === undefined ? rows : rows.filter((row) => row.id < cursorId);
        const result = candidates.slice(0, args.take);
        if (args.select) return result.map((row) => ({ id: row.id, pageId: row.pageId, status: row.status }));
        pageQueries.push(args);
        return result;
      }
    },
    wikiDiscussionComment: { async groupBy() { return []; } },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } }
  };
  const permissions = {
    async assertCanReadPage() {},
    async filterReadableThreads<T extends { thread: { id: bigint } }>({ items }: { items: T[] }) {
      return items.filter((item) => item.thread.id <= 150n);
    }
  } as unknown as WikiPermissionService;
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    permissions
  );

  const first = await discussions.listThreadsPage(page.id.toString(), null, undefined, 10);
  const firstQueryCount = pageQueries.length;
  assert.deepEqual(first.items, []);
  assert.ok(first.nextCursor);
  assert.deepEqual(pageQueries.slice(0, firstQueryCount).map((query) => query.take), [50, 50, 50, 50, 50, 1]);

  const second = await discussions.listThreadsPage(page.id.toString(), null, first.nextCursor ?? undefined, 10);
  assert.deepEqual(second.items.map((item) => item.id), ['150', '149', '148', '147', '146', '145', '144', '143', '142', '141']);
  assert.equal(new Set(second.items.map((item) => item.id)).size, second.items.length);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(second.statusCounts, { total: 10, open: 10, paused: 0, closed: 0 });
  assert.equal(second.statusCountsComplete, true);
});

test('recent server discussions deep-link through the canonical tool route', async () => {
  const serverPage = {
    ...page,
    namespaceId: 2,
    spaceId: 9n,
    localPath: 'luna/draft-api',
    title: 'luna/draft-api',
    displayTitle: 'Draft API',
    currentRevisionId: 201n,
  };
  const releaseItem = {
    id: 80n,
    releaseId: 70n,
    serverWikiId: 60n,
    spaceId: 9n,
    namespaceId: 2,
    pageId: serverPage.id,
    revisionId: 200n,
    localPath: 'luna/API/requests',
    slug: 'requests',
    title: 'luna/API/requests',
    displayTitle: 'API requests',
    pageType: 'article',
    protectionLevel: 'open',
    pageStatus: 'normal',
    createdBy: 20n,
    ownerProfileId: null,
    pageUpdatedAt: new Date('2026-07-17T00:00:00Z'),
    searchVector: '',
    createdAt: new Date('2026-07-17T00:00:00Z'),
  };
  let publicationStatus = 'published';
  let preview = false;
  let releaseRevisionPublic = true;
  const store = {
    wikiDiscussionThread: { async findMany() { return [{ ...thread, pageId: serverPage.id }]; } },
    wikiPage: { async findMany() { return [serverPage]; } },
    wikiPageRevision: {
      async findMany(args: { where: { id: { in: bigint[] } } }) {
        return args.where.id.in.flatMap((id) => id === releaseItem.revisionId && !releaseRevisionPublic ? [] : [{ id }]);
      },
    },
    wikiNamespace: { async findMany() { return [{ id: 2, code: 'server' }]; } },
    serverWiki: {
      async findMany() {
        return [{
          id: 60n,
          spaceId: 9n,
          slug: 'luna',
          siteSlug: 'public-docs',
          publicationStatus,
          publishedReleaseId: publicationStatus === 'published' ? 70n : null,
        }];
      },
    },
    serverWikiReleaseItem: { async findMany() { return [releaseItem]; } },
    wikiDiscussionComment: { async groupBy() { return [{ threadId: thread.id, _count: { _all: 1 } }]; } },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } }
  };
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    {
      async canPreviewServerWikiSpace() { return preview; },
      async filterReadableThreads<T>({ items }: { items: T[] }) { return items; },
    } as unknown as WikiPermissionService
  );
  const result = await discussions.listRecent(null, { limit: 30 });
  assert.equal(result.items[0]?.pageTitle, 'API requests');
  assert.equal(result.items[0]?.routePath, '/serverWiki/public-docs/API/requests');
  assert.equal(
    result.items[0]?.discussionHref,
    '/serverWiki/public-docs/_tools/discuss/API/requests?thread=30'
  );

  releaseRevisionPublic = false;
  assert.deepEqual((await discussions.listRecent(null, { limit: 30 })).items, []);
  releaseRevisionPublic = true;

  publicationStatus = 'draft';
  assert.deepEqual((await discussions.listRecent(null, { limit: 30 })).items, []);

  preview = true;
  const previewResult = await discussions.listRecent(null, { limit: 30 });
  assert.equal(previewResult.items[0]?.pageTitle, 'Draft API');
  assert.equal(previewResult.items[0]?.routePath, '/serverWiki/public-docs/draft-api');
});

test('focused comment windows include both sides of the requested comment', async () => {
  const commentQueries: Array<{ where: unknown; orderBy: unknown; take: number }> = [];
  const makeComment = (id: bigint) => ({ id, threadId: thread.id, content: `comment-${id}`, status: 'normal', createdBy: 20n, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: null });
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiDiscussionComment: {
      async findUnique() { return { threadId: thread.id }; },
      async count() { return 150; },
      async findMany(args: { where: { id?: { lte?: bigint; gt?: bigint } }; orderBy: unknown; take: number }) {
        commentQueries.push(args);
        return args.where.id?.lte ? [makeComment(40n), makeComment(39n), makeComment(38n)] : [makeComment(41n), makeComment(42n), makeComment(43n)];
      }
    },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } }
  };
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    { async assertCanReadPage() {} } as unknown as WikiPermissionService
  );

  const result = await discussions.getThread(thread.id.toString(), null, undefined, 4, '40');
  assert.deepEqual(commentQueries.map((query) => query.where), [
    { threadId: thread.id, id: { lte: 40n } },
    { threadId: thread.id, id: { gt: 40n } }
  ]);
  assert.deepEqual(result.comments.map((comment) => comment.id), ['39', '40', '41', '42']);
  assert.equal(result.olderCommentCursor, '39');
  assert.equal(result.newerCommentCursor, '42');
  assert.equal(result.nextCommentCursor, '39');
});

test('newer comment cursors continue forward from a focused window', async () => {
  let commentQuery: { where: unknown; orderBy: unknown; take: number } | undefined;
  const makeComment = (id: bigint) => ({ id, threadId: thread.id, content: `comment-${id}`, status: 'normal', createdBy: 20n, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: null });
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiDiscussionComment: {
      async count() { return 150; },
      async findMany(args: { where: unknown; orderBy: unknown; take: number }) {
        commentQuery = args;
        return [makeComment(43n), makeComment(44n), makeComment(45n)];
      }
    },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } }
  };
  const discussions = new WikiDiscussionService(
    store as unknown as PrismaService,
    {} as WikiProfileService,
    { async assertCanReadPage() {} } as unknown as WikiPermissionService
  );

  const result = await discussions.getThread(thread.id.toString(), null, '42', 2, undefined, 'newer');
  assert.deepEqual(commentQuery, {
    where: { threadId: thread.id, id: { gt: 42n } },
    orderBy: [{ id: 'asc' }],
    take: 3
  });
  assert.deepEqual(result.comments.map((comment) => comment.id), ['43', '44']);
  assert.equal(result.olderCommentCursor, null);
  assert.equal(result.newerCommentCursor, '44');
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

test('direct thread detail fails with 404 before comments are loaded when thread read ACL denies', async () => {
  let commentsLoaded = false;
  const store = {
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionComment: { async findMany() { commentsLoaded = true; return []; } }
  };
  const permissions = {
    async assertCanReadPage() {},
    async assertCanReadThread() { throw new NotFoundException('hidden'); }
  } as unknown as WikiPermissionService;
  const discussions = new WikiDiscussionService(store as unknown as PrismaService, {} as WikiProfileService, permissions);
  await assert.rejects(discussions.getThread('30'), NotFoundException);
  assert.equal(commentsLoaded, false);
});

test('thread ACL filtering removes hidden rows from page lists and status counts together', async () => {
  const open = { ...thread, id: 31n, status: 'open' };
  const closed = { ...thread, id: 32n, status: 'closed' };
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: { async findMany() { return [open, closed]; } },
    wikiDiscussionComment: { async groupBy() { return []; } },
    wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } }
  };
  const permissions = {
    async assertCanReadPage() {},
    async filterReadableThreads(input: { items: Array<{ thread: typeof thread }> }) {
      return input.items.filter((item) => item.thread.id === open.id);
    }
  } as unknown as WikiPermissionService;
  const discussions = new WikiDiscussionService(store as unknown as PrismaService, {} as WikiProfileService, permissions);
  const result = await discussions.listThreadsPage('10', null);
  assert.deepEqual(result.items.map((item) => item.id), ['31']);
  assert.deepEqual(result.statusCounts, { total: 1, open: 1, paused: 0, closed: 0 });
});

test('read-only thread members can subscribe without write-thread-comment permission', async () => {
  let readChecks = 0;
  let writeChecks = 0;
  let subscribed = false;
  const store = {
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionSubscription: { async upsert() { subscribed = true; return {}; } },
    async $queryRaw() { return []; },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(store); }
  };
  const profiles = { async ensureWikiProfile() { return { id: 20n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: session.userId, profileId: 20n, status: 'active' }; },
    async assertCanReadPage() {},
    async assertCanReadThread() { readChecks += 1; },
    async assertCanWriteThreadComment() { writeChecks += 1; throw new ForbiddenException('write denied'); }
  } as unknown as WikiPermissionService;
  const discussions = new WikiDiscussionService(store as unknown as PrismaService, profiles, permissions);
  await discussions.setSubscription(session, '30', true);
  assert.equal(readChecks, 2);
  assert.equal(writeChecks, 0);
  assert.equal(subscribed, true);
});

test('discussion invalidation is published only after the database mutation resolves', async () => {
  let committed = false;
  let published = false;
  const store = {
    wikiDiscussionThread: {
      async findUnique() { return thread; },
      async update() { committed = true; return { ...thread, status: 'deleted' }; }
    },
    wikiPage: { async findUnique() { return page; } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 20n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: session.userId, profileId: 20n, status: 'active' }; },
    async assertCanReadThread() {},
    async canManagePage() { return true; }
  } as unknown as WikiPermissionService;
  const live = {
    publish(id: bigint) {
      assert.equal(committed, true);
      assert.equal(id, thread.id);
      published = true;
    }
  } as unknown as WikiDiscussionLiveService;
  const discussions = new WikiDiscussionService(store, profiles, permissions, undefined, undefined, live);

  await discussions.deleteThread(session, '30', '정리');
  assert.equal(published, true);
});

test('anonymous discussion stores capability ownership and a non-reversible address hash without a profile', async () => {
  const writes: unknown[] = [];
  const tx = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: {
      async count() { return 0; },
      async create(input: { data: unknown }) {
        writes.push(input.data);
        return { ...thread, createdBy: null, anonymousOwnerId: 90n, actorIpHash: 'h'.repeat(64) };
      },
    },
    wikiDiscussionComment: {
      async create(input: { data: unknown }) { writes.push(input.data); return { id: 91n }; },
    },
    wikiAnonymousContributorSession: {
      async findFirst() { return null; },
      async create() { return { id: 90n }; },
    },
  };
  const store = {
    ...tx,
    async $transaction(callback: (client: typeof tx) => Promise<unknown>) { return callback(tx); },
  } as unknown as PrismaService;
  const permissions = {
    async assertCanCreateThread(input: { actor: unknown; requestIp: string }) {
      assert.equal(input.actor, null);
      assert.equal(input.requestIp, '192.0.2.44');
    },
  } as unknown as WikiPermissionService;
  const config = {
    getOptional(key: string) {
      if (key === 'WIKI_ANONYMOUS_DISCUSSIONS_ENABLED') return 'true';
      if (key === 'WIKI_ANONYMOUS_IP_HASH_SECRET') return 'test-discussion-ip-secret';
      return undefined;
    },
  };
  const discussions = new WikiDiscussionService(
    store,
    {} as WikiProfileService,
    permissions,
    undefined,
    undefined,
    undefined,
    config as never,
  );
  discussions.getThread = async () => ({ id: '30' }) as never;

  const result = await discussions.createAnonymousThread(
    page.id.toString(),
    { title: '익명 토론', content: '익명 본문' },
    '192.0.2.44',
  );

  assert.equal(result.ownerTokenIssued, true);
  assert.equal(result.ownerToken.length, 43);
  for (const write of writes as Array<{ createdBy: bigint | null; anonymousOwnerId: bigint; actorIpHash: string }>) {
    assert.equal(write.createdBy, null);
    assert.equal(write.anonymousOwnerId, 90n);
    assert.match(write.actorIpHash, /^[a-f0-9]{64}$/u);
    assert.notEqual(write.actorIpHash, '192.0.2.44');
  }
});
