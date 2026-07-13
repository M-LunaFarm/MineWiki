import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';
import { WikiWatchService } from './wiki-watch.service';

const session = { userId: 'account-1' } as SessionPayload;
const page = {
  id: 10n,
  namespaceId: 1,
  spaceId: 2n,
  localPath: 'guide',
  slug: 'guide',
  title: 'Guide',
  displayTitle: 'Guide',
  currentRevisionId: 30n,
  pageType: 'article',
  protectionLevel: 'open',
  status: 'normal',
  createdBy: 20n,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z')
};

function createService(watch: { lastSeenRevisionId: bigint | null } | null, onUpsert?: (args: unknown) => void) {
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiPageWatch: {
      async findUnique() { return watch; },
      async upsert(args: unknown) { onUpsert?.(args); return {}; }
    }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 20n }; } } as unknown as WikiProfileService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;
  return new WikiWatchService(prisma, profiles, permissions);
}

test('watch status marks a changed current revision as unread', async () => {
  const watches = createService({ lastSeenRevisionId: 29n });
  assert.deepEqual(await watches.status(session, page.id.toString()), { watched: true, unread: true });
});

test('watching a page records the current revision as seen', async () => {
  let upsert: { create: { lastSeenRevisionId: bigint | null }; update: { lastSeenRevisionId: bigint | null } } | undefined;
  const watches = createService(null, (args) => {
    upsert = args as typeof upsert;
  });
  assert.deepEqual(await watches.watch(session, page.id.toString()), { watched: true, unread: false });
  assert.equal(upsert?.create.lastSeenRevisionId, page.currentRevisionId);
  assert.equal(upsert?.update.lastSeenRevisionId, page.currentRevisionId);
});
