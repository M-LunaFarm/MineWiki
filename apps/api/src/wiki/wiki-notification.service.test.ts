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
