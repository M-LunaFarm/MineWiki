import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { WikiNotificationService } from './wiki-notification.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';

const session = { userId: 'account-1' } as SessionPayload;
const now = new Date('2026-07-13T00:00:00Z');

test('notification inbox belongs to the authenticated wiki profile', async () => {
  let where: unknown;
  const prisma = {
    wikiNotification: {
      async findMany(args: { where: unknown }) { where = args.where; return [{ id: 4n, profileId: 8n, type: 'page_revision', pageId: null, actorProfileId: null, sourceType: 'revision', sourceId: '3', title: 'Guide', message: null, href: '/wiki/revision/3', dedupeKey: 'key', readAt: null, createdAt: now }]; },
      async count() { return 1; }
    },
    wikiProfile: { async findMany() { return []; } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 8n }; } } as unknown as WikiProfileService;
  const service = new WikiNotificationService(prisma, profiles, {} as WikiPermissionService);

  const result = await service.list(session);
  assert.deepEqual(where, { profileId: 8n });
  assert.equal(result.unreadCount, 1);
  assert.equal(result.items[0]?.id, '4');
});

test('notification read state updates stay scoped to the authenticated wiki profile', async () => {
  const updates: Array<{ where: unknown; data: unknown }> = [];
  const prisma = {
    wikiNotification: {
      async updateMany(args: { where: unknown; data: unknown }) { updates.push(args); return { count: 1 }; }
    }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 8n }; } } as unknown as WikiProfileService;
  const service = new WikiNotificationService(prisma, profiles, {} as WikiPermissionService);

  assert.deepEqual(await service.markRead(session, '44'), { read: true });
  assert.deepEqual(await service.markUnread(session, '44'), { read: false });
  assert.deepEqual(updates[0]?.where, { id: 44n, profileId: 8n });
  assert.ok((updates[0]?.data as { readAt?: unknown }).readAt instanceof Date);
  assert.deepEqual(updates[1], { where: { id: 44n, profileId: 8n }, data: { readAt: null } });
});

test('notification inbox applies validated read-state filters in the database query', async () => {
  const whereValues: unknown[] = [];
  const prisma = {
    wikiNotification: {
      async findMany(args: { where: unknown }) { whereValues.push(args.where); return []; },
      async count() { return 0; }
    },
    wikiProfile: { async findMany() { return []; } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 8n }; } } as unknown as WikiProfileService;
  const service = new WikiNotificationService(prisma, profiles, {} as WikiPermissionService);

  await service.list(session, undefined, 30, 'unread');
  await service.list(session, undefined, 30, 'read');
  assert.deepEqual(whereValues, [
    { profileId: 8n, readAt: null },
    { profileId: 8n, readAt: { not: null } }
  ]);
  await assert.rejects(() => service.list(session, undefined, 30, 'unknown'), /state must be all, unread, or read/);
});

test('notification inbox upgrades legacy server discussion links to canonical routes', async () => {
  const prisma = {
    wikiNotification: {
      async findMany() { return [{ id: 4n, profileId: 8n, type: 'discussion_reply', pageId: 2n, actorProfileId: null, sourceType: 'discussion_comment', sourceId: '4', title: 'Guide', message: null, href: '/wiki/discuss/2?thread=3&comment=4', dedupeKey: 'key', readAt: null, createdAt: now }]; },
      async count() { return 1; }
    },
    wikiPage: { async findMany() { return [{ id: 2n, namespaceId: 2, spaceId: 9n, localPath: 'luna/API/requests', status: 'normal' }]; } },
    wikiNamespace: { async findMany() { return [{ id: 2, code: 'server' }]; } },
    serverWiki: { async findMany() { return [{ spaceId: 9n, slug: 'luna' }]; } },
    wikiProfile: { async findMany() { return []; } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 8n }; } } as unknown as WikiProfileService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;

  const result = await new WikiNotificationService(prisma, profiles, permissions).list(session);

  assert.equal(result.items[0]?.href, '/server/luna/_tools/discuss/API/requests?thread=3&comment=4');
});

test('notification inbox upgrades legacy server edit request links to canonical detail routes', async () => {
  const prisma = {
    wikiNotification: {
      async findMany() { return [{ id: 5n, profileId: 8n, type: 'edit_request_accepted', pageId: 2n, actorProfileId: null, sourceType: 'edit_request', sourceId: '44', title: 'Guide', message: null, href: '/wiki/edit-requests/2', dedupeKey: 'key', readAt: null, createdAt: now }]; },
      async count() { return 1; }
    },
    wikiPage: { async findMany() { return [{ id: 2n, namespaceId: 2, spaceId: 9n, localPath: 'luna/API/requests', status: 'normal' }]; } },
    wikiNamespace: { async findMany() { return [{ id: 2, code: 'server' }]; } },
    serverWiki: { async findMany() { return [{ spaceId: 9n, slug: 'luna' }]; } },
    wikiProfile: { async findMany() { return []; } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 8n }; } } as unknown as WikiProfileService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;

  const result = await new WikiNotificationService(prisma, profiles, permissions).list(session);

  assert.equal(result.items[0]?.href, '/server/luna/_tools/requests/API/requests?request=44');
});

test('notification inbox removes notifications whose source comment is hidden', async () => {
  let deletedIds: bigint[] = [];
  let purgeQuery: { orderBy?: unknown; take?: number } | undefined;
  const row = { id: 4n, profileId: 8n, type: 'discussion_mention', pageId: 2n, actorProfileId: null, sourceType: 'discussion_comment', sourceId: '4', title: 'Guide', message: null, href: '/wiki/discuss/2?thread=3&comment=4', dedupeKey: 'key', readAt: now, createdAt: now };
  const prisma = {
    wikiNotification: {
      async findMany(args: { select?: unknown; orderBy?: unknown; take?: number }) {
        if (args.select) { purgeQuery = args; return []; }
        return [row];
      },
      async count() { return 0; },
      async deleteMany(args: { where: { id: { in: bigint[] } } }) { deletedIds = args.where.id.in; return { count: deletedIds.length }; }
    },
    wikiPage: { async findMany() { return [{ id: 2n, namespaceId: 1, spaceId: 1n, localPath: 'Guide', status: 'normal' }]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } },
    wikiDiscussionComment: { async findMany() { return [{ id: 4n, threadId: 3n, status: 'hidden' }]; } },
    wikiDiscussionThread: { async findMany() { return [{ id: 3n, pageId: 2n, status: 'open' }]; } },
    wikiProfile: { async findMany() { return []; } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 8n }; } } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return null; },
    async filterReadablePages(input: { pages: unknown[] }) { return input.pages; },
    async filterReadableThreads(input: { items: unknown[] }) { return input.items; }
  } as unknown as WikiPermissionService;

  const result = await new WikiNotificationService(prisma, profiles, permissions).list(session);

  assert.deepEqual(result.items, []);
  assert.deepEqual(deletedIds, [4n]);
  assert.deepEqual(purgeQuery?.orderBy, { id: 'desc' });
  assert.equal(purgeQuery?.take, 200);
});

test('release review inbox drops submissions after reviewer access is revoked', async () => {
  const deletedIds: bigint[] = [];
  const row = { id: 44n, profileId: 8n, type: 'server_wiki_release_submitted', pageId: null, actorProfileId: 7n, sourceType: 'server_wiki_release_candidate', sourceId: '12', title: 'Luna', message: null, href: '/wiki/release-reviews/12', dedupeKey: 'release:12', readAt: null, createdAt: now };
  const prisma = {
    wikiNotification: {
      async findMany() { return [row]; },
      async count() { return 0; },
      async deleteMany(args: { where: { id: { in: bigint[] } } }) {
        deletedIds.push(...args.where.id.in);
        return { count: args.where.id.in.length };
      },
    },
    serverWikiReleaseCandidate: {
      async findMany() { return [{ id: 12n, spaceId: 3n, status: 'pending_review', createdBy: 7n }]; },
    },
    subwikiRole: { async findMany() { return []; } },
    wikiProfile: { async findMany() { return []; } },
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 8n }; } } as unknown as WikiProfileService;

  const result = await new WikiNotificationService(prisma, profiles, {} as WikiPermissionService).list(session);

  assert.deepEqual(result.items, []);
  assert.deepEqual(deletedIds, [44n]);
});

test('watched revision notifications exclude the editor and deduplicate per recipient', async () => {
  let deliveries: Array<{ profileId: string; dedupeKey: string }> = [];
  const tx = {
    wikiPageWatch: { async findMany() { return [{ profileId: 8n }, { profileId: 9n }]; } },
    wikiNotificationEvent: { async createMany(args: { data: Array<{ payloadJson: { deliveries: typeof deliveries } }> }) { deliveries = args.data[0]?.payloadJson.deliveries ?? []; return { count: 1 }; } }
  };
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);
  await service.notifyWatchedRevision(tx as never, { pageId: 2n, revisionId: 3n, actorProfileId: 7n, title: 'Guide' });

  assert.deepEqual(deliveries.map((item) => item.profileId), ['8', '9']);
  assert.deepEqual(deliveries.map((item) => item.dedupeKey), ['revision:3:profile:8', 'revision:3:profile:9']);
});

test('server wiki collaborator invite notification uses a versioned outbox delivery', async () => {
  let event: { eventKey: string; payloadJson: { deliveries: Array<{ profileId: string; href: string; dedupeKey: string }> } } | null = null;
  const tx = { wikiNotificationEvent: { async createMany(args: { data: typeof event[] }) { event = args.data[0] ?? null; return { count: 1 }; } } };
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);
  await service.notifyServerWikiCollaboratorInvited(tx as never, {
    invitationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', targetProfileId: 8n,
    actorProfileId: 7n, serverName: 'Luna', roleLabel: '편집자', invitedAt: now, deliveryVersion: 2,
  });
  assert.equal(event?.eventKey, 'server-wiki-collaborator-invitation:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:delivery:2');
  assert.equal(event?.payloadJson.deliveries[0]?.profileId, '8');
  assert.equal(event?.payloadJson.deliveries[0]?.href, '/me#server-wiki-invitations');
  assert.match(event?.payloadJson.deliveries[0]?.dedupeKey ?? '', /delivery:2:profile:8/u);
});

test('invitation state notification deduplicates recipients and excludes the actor', async () => {
  let deliveries: Array<{ profileId: string; href: string }> = [];
  const tx = { wikiNotificationEvent: { async createMany(args: { data: Array<{ payloadJson: { deliveries: Array<{ profileId: string; href: string }> } }> }) { deliveries = (args.data[0]?.payloadJson.deliveries ?? []).map(({ profileId, href }) => ({ profileId, href })); return { count: 1 }; } } };
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);
  await service.notifyServerWikiCollaboratorInvitationChanged(tx as never, {
    invitationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', recipientProfileIds: [7n, 8n, 8n],
    actorProfileId: 7n, serverId: '11111111-1111-4111-8111-111111111111', serverName: 'Luna',
    state: 'accepted', changedAt: now, version: 2,
  });
  assert.deepEqual(deliveries, [{ profileId: '8', href: '/servers/11111111-1111-4111-8111-111111111111/wiki-layouts?tab=collaborators' }]);
});

test('discussion reply notifications deep-link to the exact comment', async () => {
  let href = '';
  const tx = {
    wikiDiscussionThread: { async findUnique() { return { createdBy: 8n }; } },
    wikiDiscussionComment: { async findMany() { return []; } },
    wikiDiscussionSubscription: { async findMany() { return []; } },
    wikiPage: { async findUnique() { return { namespaceId: 1, spaceId: 1n, localPath: 'Guide' }; } },
    wikiNamespace: { async findUnique() { return { code: 'main' }; } },
    wikiNotificationEvent: {
      async createMany(args: { data: Array<{ payloadJson: { deliveries: Array<{ href: string }> } }> }) { href = args.data[0]?.payloadJson.deliveries[0]?.href ?? ''; return { count: 1 }; }
    }
  };
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);
  await service.notifyDiscussionReply(tx as never, { pageId: 2n, threadId: 3n, commentId: 4n, actorProfileId: 7n, title: 'Guide' });

  assert.equal(href, '/wiki/discuss/2?thread=3&comment=4');
});

test('server wiki discussion notifications keep the canonical workspace route', async () => {
  let href = '';
  const tx = {
    wikiDiscussionThread: { async findUnique() { return { createdBy: 8n }; } },
    wikiDiscussionComment: { async findMany() { return []; } },
    wikiDiscussionSubscription: { async findMany() { return []; } },
    wikiPage: { async findUnique() { return { namespaceId: 2, spaceId: 9n, localPath: 'luna/API/requests' }; } },
    wikiNamespace: { async findUnique() { return { code: 'server' }; } },
    serverWiki: { async findFirst() { return { slug: 'luna' }; } },
    wikiNotificationEvent: {
      async createMany(args: { data: Array<{ payloadJson: { deliveries: Array<{ href: string }> } }> }) { href = args.data[0]?.payloadJson.deliveries[0]?.href ?? ''; return { count: 1 }; }
    }
  };
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);
  await service.notifyDiscussionReply(tx as never, { pageId: 2n, threadId: 3n, commentId: 4n, actorProfileId: 7n, title: 'Guide' });

  assert.equal(href, '/server/luna/_tools/discuss/API/requests?thread=3&comment=4');
});

test('server wiki edit request review notifications keep the canonical detail route', async () => {
  let href = '';
  const tx = {
    wikiPage: { async findUnique() { return { namespaceId: 2, spaceId: 9n, localPath: 'luna/API/requests' }; } },
    wikiNamespace: { async findUnique() { return { code: 'server' }; } },
    serverWiki: { async findFirst() { return { slug: 'luna' }; } },
    wikiNotificationEvent: {
      async createMany(args: { data: Array<{ payloadJson: { deliveries: Array<{ href: string }> } }> }) { href = args.data[0]?.payloadJson.deliveries[0]?.href ?? ''; return { count: 1 }; }
    }
  };
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);

  await service.notifyEditRequestReviewed(tx as never, {
    profileId: 8n, pageId: 2n, requestId: 44n, reviewerProfileId: 7n, status: 'accepted', title: 'Guide'
  });

  assert.equal(href, '/server/luna/_tools/requests/API/requests?request=44');
});

test('release submission notifications fan out only to active canonical reviewers in the same space', async () => {
  let roleQuery: unknown;
  let event: { eventKey: string; eventType: string; payloadJson: { deliveries: Array<{ profileId: string; href: string; dedupeKey: string }> } } | null = null;
  const tx = {
    subwikiRole: {
      async findMany(args: unknown) {
        roleQuery = args;
        return [{ userId: 8n }, { userId: 9n }, { userId: 10n }];
      },
    },
    wikiProfile: {
      async findMany() {
        return [
          { id: 8n, accountId: 'account-8' },
          { id: 9n, accountId: 'account-9' },
        ];
      },
    },
    account: {
      async findMany() {
        return [
          { id: 'account-8', canonicalAccountId: null },
          { id: 'account-9', canonicalAccountId: 'canonical-9' },
        ];
      },
    },
    wikiNotificationEvent: {
      async createMany(args: { data: typeof event[] }) { event = args.data[0] ?? null; return { count: 1 }; },
    },
  };
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);

  await service.notifyServerWikiReleaseSubmitted(tx as never, {
    candidateId: 44n,
    spaceId: 77n,
    actorProfileId: 7n,
    serverName: 'Luna',
    submittedAt: now,
  });

  assert.deepEqual((roleQuery as { where: unknown }).where, {
    spaceId: 77n, role: 'reviewer', status: 'active', userId: { not: 7n },
  });
  assert.equal(event?.eventType, 'server_wiki_release_submitted');
  assert.deepEqual(event?.payloadJson.deliveries.map((delivery) => delivery.profileId), ['8']);
  assert.equal(event?.payloadJson.deliveries[0]?.href, '/wiki/release-reviews/44');
  assert.match(event?.payloadJson.deliveries[0]?.dedupeKey ?? '', /candidate|server-wiki-release:44/u);
});

test('release review changes notify the active submitter once and never notify the reviewer themself', async () => {
  const events: Array<{ eventKey: string; payloadJson: { deliveries: Array<{ profileId: string; actorProfileId: string }> } }> = [];
  const tx = {
    wikiProfile: { async findMany() { return [{ id: 8n, accountId: 'account-8' }]; } },
    account: { async findMany() { return [{ id: 'account-8', canonicalAccountId: null }]; } },
    wikiNotificationEvent: {
      async createMany(args: { data: typeof events }) { events.push(...args.data); return { count: args.data.length }; },
    },
  };
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);

  await service.notifyServerWikiReleaseReviewChanged(tx as never, {
    candidateId: 44n, serverId: '11111111-1111-4111-8111-111111111111', submitterProfileId: 8n, reviewerProfileId: 7n,
    serverName: 'Luna', state: 'approved', changedAt: now,
  });
  await service.notifyServerWikiReleaseReviewChanged(tx as never, {
    candidateId: 45n, serverId: '11111111-1111-4111-8111-111111111111', submitterProfileId: 7n, reviewerProfileId: 7n,
    serverName: 'Luna', state: 'revoked', changedAt: now,
  });
  await service.notifyServerWikiReleaseReviewChanged(tx as never, {
    candidateId: 46n, serverId: '11111111-1111-4111-8111-111111111111', submitterProfileId: 8n, reviewerProfileId: 7n,
    serverName: 'Luna', state: 'changes_requested', changedAt: now,
  });

  assert.equal(events.length, 2);
  assert.equal(events[0]?.eventKey, 'server-wiki-release:44:approved:reviewer:7');
  assert.deepEqual(events[0]?.payloadJson.deliveries[0], {
    profileId: '8',
    type: 'server_wiki_release_approved',
    pageId: null,
    actorProfileId: '7',
    sourceType: 'server_wiki_release_candidate',
    sourceId: '44',
    title: 'Luna',
    message: '서버 위키 릴리스 후보가 승인되었습니다.',
    href: '/servers/11111111-1111-4111-8111-111111111111/wiki-layouts',
    dedupeKey: 'server-wiki-release:44:approved:reviewer:7:profile:8',
    readAt: null,
    createdAt: now.toISOString(),
  });
  assert.equal(events[1]?.eventKey, 'server-wiki-release:46:changes_requested:reviewer:7');
  assert.equal((events[1]?.payloadJson.deliveries[0] as { type?: string } | undefined)?.type, 'server_wiki_release_changes_requested');
});

test('rejected new-page requests notify the author through the request identity route', async () => {
  let delivery: { pageId: string | null; href: string } | null = null;
  const tx = {
    wikiNotificationEvent: {
      async createMany(args: { data: Array<{ payloadJson: { deliveries: Array<{ pageId: string | null; href: string }> } }> }) {
        const item = args.data[0]?.payloadJson.deliveries[0];
        delivery = item ? { pageId: item.pageId, href: item.href } : null;
        return { count: 1 };
      }
    }
  };
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);

  await service.notifyEditRequestReviewed(tx as never, {
    profileId: 8n, pageId: null, requestId: 45n, reviewerProfileId: 7n, status: 'rejected', title: '새 문서'
  });

  assert.deepEqual(delivery, { pageId: null, href: '/wiki/edit-requests/request/45' });
});

test('muted discussion subscribers are excluded from reply delivery', async () => {
  let deliveries: Array<{ profileId: string }> = [];
  const tx = {
    wikiDiscussionThread: { async findUnique() { return { createdBy: 8n }; } },
    wikiDiscussionComment: { async findMany() { return [{ createdBy: 9n }]; } },
    wikiDiscussionSubscription: { async findMany() { return [{ profileId: 8n, muted: true }, { profileId: 9n, muted: false }]; } },
    wikiPage: { async findUnique() { return { namespaceId: 1, spaceId: 1n, localPath: 'Guide' }; } },
    wikiNamespace: { async findUnique() { return { code: 'main' }; } },
    wikiNotificationEvent: {
      async createMany(args: { data: Array<{ payloadJson: { deliveries: typeof deliveries } }> }) { deliveries = args.data[0]?.payloadJson.deliveries ?? []; return { count: 1 }; }
    }
  };
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);
  await service.notifyDiscussionReply(tx as never, { pageId: 2n, threadId: 3n, commentId: 4n, actorProfileId: 7n, title: 'Guide' });
  assert.deepEqual(deliveries.map((delivery) => delivery.profileId), ['9']);
});

test('discussion mentions notify only active readable non-muted targets and use a distinct dedupe key', async () => {
  let deliveries: Array<{ profileId: string; type: string; dedupeKey: string; href: string }> = [];
  const tx = {
    wikiDiscussionThread: { async findUnique() { return { id: 3n, pageId: 2n, status: 'open', createdBy: 7n }; } },
    wikiDiscussionSubscription: { async findMany() { return [{ profileId: 9n, muted: true }]; } },
    wikiPage: { async findUnique() { return { id: 2n, namespaceId: 1, spaceId: 1n, localPath: 'Guide', title: 'Guide', protectionLevel: 'open', status: 'normal', createdBy: 7n }; } },
    wikiProfile: { async findMany(args: { where?: { id?: { in: bigint[] } } }) {
      const rows = [
        { id: 7n, username: 'self', accountId: 'account-7', status: 'active' },
        { id: 8n, username: 'Alice', accountId: 'account-8', status: 'active' },
        { id: 9n, username: 'muted', accountId: 'account-9', status: 'active' }
      ];
      return args.where?.id ? rows.filter((row) => args.where!.id!.in.includes(row.id)) : rows;
    } },
    accountRole: { async findMany() { return []; } },
    wikiNamespace: { async findUnique() { return { code: 'main' }; } },
    wikiNotificationEvent: {
      async createMany(args: { data: Array<{ payloadJson: { deliveries: typeof deliveries } }> }) {
        deliveries = args.data[0]?.payloadJson.deliveries ?? [];
        return { count: 1 };
      }
    }
  };
  const permissions = { async filterReadableThreads(input: { items: unknown[] }) { return input.items; } } as unknown as WikiPermissionService;
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, permissions);

  const recipients = await service.notifyDiscussionMentions(tx as never, {
    pageId: 2n, threadId: 3n, commentId: 4n, actorProfileId: 7n, title: 'Guide',
    usernames: ['self', 'Alice', 'muted', 'missing']
  });

  assert.deepEqual(recipients, [8n]);
  assert.deepEqual(deliveries.map(({ profileId, type, dedupeKey, href }) => ({ profileId, type, dedupeKey, href })), [{
    profileId: '8', type: 'discussion_mention',
    dedupeKey: 'discussion-mention:4:profile:8', href: '/wiki/discuss/2?thread=3&comment=4'
  }]);
});

test('discussion reply excludes recipients already notified by a mention', async () => {
  let deliveries: Array<{ profileId: string }> = [];
  const tx = {
    wikiDiscussionThread: { async findUnique() { return { createdBy: 8n }; } },
    wikiDiscussionComment: { async findMany() { return [{ createdBy: 9n }]; } },
    wikiDiscussionSubscription: { async findMany() { return []; } },
    wikiPage: { async findUnique() { return { namespaceId: 1, spaceId: 1n, localPath: 'Guide' }; } },
    wikiNamespace: { async findUnique() { return { code: 'main' }; } },
    wikiNotificationEvent: {
      async createMany(args: { data: Array<{ payloadJson: { deliveries: typeof deliveries } }> }) {
        deliveries = args.data[0]?.payloadJson.deliveries ?? [];
        return { count: 1 };
      }
    }
  };
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);
  await service.notifyDiscussionReply(tx as never, {
    pageId: 2n, threadId: 3n, commentId: 4n, actorProfileId: 7n, title: 'Guide', excludeProfileIds: [8n]
  });
  assert.deepEqual(deliveries.map((delivery) => delivery.profileId), ['9']);
});

test('discussion delivery persists notifications only for recipients who can currently read the thread', async () => {
  let deliveries: Array<{ profileId: string }> = [];
  const fullPage = { ...({ id: 2n, namespaceId: 1, spaceId: 1n, localPath: 'Guide', title: 'Guide', protectionLevel: 'open', status: 'normal', createdBy: 8n }) };
  const fullThread = { id: 3n, pageId: 2n, title: 'Guide', status: 'open', createdBy: 8n };
  const tx = {
    wikiDiscussionThread: { async findUnique() { return fullThread; } },
    wikiDiscussionComment: { async findMany() { return [{ createdBy: 9n }]; } },
    wikiDiscussionSubscription: { async findMany() { return []; } },
    wikiPage: { async findUnique() { return fullPage; } },
    wikiProfile: { async findMany() { return [
      { id: 8n, accountId: 'account-8', status: 'active' },
      { id: 9n, accountId: 'account-9', status: 'active' }
    ]; } },
    accountRole: { async findMany() { return []; } },
    wikiNamespace: { async findUnique() { return { code: 'main' }; } },
    wikiNotificationEvent: {
      async createMany(args: { data: Array<{ payloadJson: { deliveries: typeof deliveries } }> }) {
        deliveries = args.data[0]?.payloadJson.deliveries ?? [];
        return { count: 1 };
      }
    }
  };
  const permissions = {
    async filterReadableThreads(input: { actor: { profileId: bigint }; items: unknown[] }) {
      return input.actor.profileId === 8n ? input.items : [];
    }
  } as unknown as WikiPermissionService;
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, permissions);
  await service.notifyDiscussionReply(tx as never, {
    pageId: 2n, threadId: 3n, commentId: 4n, actorProfileId: 7n, title: 'Guide'
  });
  assert.deepEqual(deliveries.map((delivery) => delivery.profileId), ['8']);
});

test('discussion recipient ACL evaluation is capped and runs in bounded chunks', async () => {
  let active = 0;
  let maximumActive = 0;
  let deliveryCount = 0;
  const recipientIds = Array.from({ length: 600 }, (_, index) => BigInt(index + 8));
  const fullPage = { id: 2n, namespaceId: 1, spaceId: 1n, localPath: 'Guide', title: 'Guide', protectionLevel: 'open', status: 'normal', createdBy: 8n };
  const fullThread = { id: 3n, pageId: 2n, title: 'Guide', status: 'open', createdBy: 8n };
  const tx = {
    wikiDiscussionThread: { async findUnique() { return fullThread; } },
    wikiDiscussionComment: { async findMany() { return recipientIds.slice(1).map((createdBy) => ({ createdBy })); } },
    wikiDiscussionSubscription: { async findMany() { return []; } },
    wikiPage: { async findUnique() { return fullPage; } },
    wikiProfile: {
      async findMany(args: { where: { id: { in: bigint[] } } }) {
        return args.where.id.in.map((id) => ({ id, accountId: `account-${id.toString()}`, status: 'active' }));
      }
    },
    accountRole: { async findMany() { return []; } },
    wikiNamespace: { async findUnique() { return { code: 'main' }; } },
    wikiNotificationEvent: {
      async createMany(args: { data: Array<{ payloadJson: { deliveries: unknown[] } }> }) {
        deliveryCount = args.data[0]?.payloadJson.deliveries.length ?? 0;
        return { count: 1 };
      }
    }
  };
  const permissions = {
    async filterReadableThreads(input: { items: unknown[] }) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return input.items;
    }
  } as unknown as WikiPermissionService;
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, permissions);
  await service.notifyDiscussionReply(tx as never, {
    pageId: 2n, threadId: 3n, commentId: 4n, actorProfileId: 7n, title: 'Guide'
  });
  assert.equal(deliveryCount, 500);
  assert.ok(maximumActive <= 20);
});
