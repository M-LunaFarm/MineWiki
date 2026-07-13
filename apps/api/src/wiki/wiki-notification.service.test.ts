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

test('watched revision notifications exclude the editor and deduplicate per recipient', async () => {
  let created: Array<{ profileId: bigint; dedupeKey: string }> = [];
  const tx = {
    wikiPageWatch: { async findMany() { return [{ profileId: 8n }, { profileId: 9n }]; } },
    wikiNotification: { async createMany(args: { data: Array<{ profileId: bigint; dedupeKey: string }> }) { created = args.data; return { count: args.data.length }; } }
  };
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);
  await service.notifyWatchedRevision(tx as never, { pageId: 2n, revisionId: 3n, actorProfileId: 7n, title: 'Guide' });

  assert.deepEqual(created.map((item) => item.profileId), [8n, 9n]);
  assert.deepEqual(created.map((item) => item.dedupeKey), ['revision:3:profile:8', 'revision:3:profile:9']);
});

test('discussion reply notifications deep-link to the exact comment', async () => {
  let href = '';
  const tx = {
    wikiDiscussionThread: { async findUnique() { return { createdBy: 8n }; } },
    wikiDiscussionComment: { async findMany() { return []; } },
    wikiNotification: {
      async createMany(args: { data: Array<{ href: string }> }) { href = args.data[0]?.href ?? ''; return { count: args.data.length }; }
    }
  };
  const service = new WikiNotificationService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);
  await service.notifyDiscussionReply(tx as never, { pageId: 2n, threadId: 3n, commentId: 4n, actorProfileId: 7n, title: 'Guide' });

  assert.equal(href, '/wiki/discuss/2?thread=3&comment=4');
});
