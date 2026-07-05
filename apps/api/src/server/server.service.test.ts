import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ServerService } from './server.service';
import { UploadService } from '../upload/upload.service';
import { PrismaService } from '../common/prisma.service';
import type { ConfigService } from '@minewiki/config';
import { WikiProfileService } from '../wiki/wiki-profile.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const wikiProfiles = new WikiProfileService(prisma);

  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  function createService(): { service: ServerService; cleanup: () => void } {
    const storageRoot = mkdtempSync(join(tmpdir(), 'uploads-'));
    const configStub = {
      getOptional(key: string) {
        if (key === 'UPLOAD_STORAGE_ROOT') {
          return storageRoot;
        }
        return undefined;
      }
    } as unknown as ConfigService;
    const uploadService = new UploadService(configStub);
    const service = new ServerService(uploadService, prisma, wikiProfiles);
    return {
      service,
      cleanup: () => rmSync(storageRoot, { recursive: true, force: true })
    };
  }

  test('updateBanner stores sanitized image and updates server detail', async () => {
    const { service, cleanup } = createService();
    try {
      const name = 'Test Server ' + randomUUID().slice(0, 8);
      const server = await service.register({
        name,
        joinHost: 'play.example.com',
        joinPort: 25565,
        edition: 'java',
        supportedVersions: ['1.20.1'],
        tags: ['community'],
        shortDescription: 'Test server',
        longDescription: 'Long description',
        websiteUrl: null,
        discordUrl: null
      });

      const buffer = await sharp({
        create: {
          width: 800,
          height: 400,
          channels: 3,
          background: '#abcdef'
        }
      })
        .jpeg()
        .toBuffer();

      const stored = await service.updateBanner(server.id, { buffer, filename: 'banner.jpg' });

      const detail = await service.detail(server.id);
      assert.equal(detail.bannerUrl, stored.publicPath);
      assert.ok(stored.filename.endsWith('.webp'));
      assert.ok(stored.width <= 800);
      assert.ok(statSync(stored.storagePath).isFile());
    } finally {
      cleanup();
    }
  });

  test('uploadContentImage stores sanitized image for markdown content', async () => {
    const { service, cleanup } = createService();
    try {
      const buffer = await sharp({
        create: {
          width: 1200,
          height: 800,
          channels: 3,
          background: '#123456'
        }
      })
        .png()
        .toBuffer();

      const stored = await service.uploadContentImage({ buffer, filename: 'content.png' });
      assert.ok(stored.publicPath.length > 0);
      assert.ok(stored.filename.endsWith('.webp'));
      assert.ok(stored.width <= 1200);
      assert.ok(statSync(stored.storagePath).isFile());
    } finally {
      cleanup();
    }
  });

  test('creates and links a server wiki space with a main page', async () => {
    const { service, cleanup } = createService();
    const unique = randomUUID().replace(/-/g, '').slice(0, 12);
    let serverId: string | null = null;
    let accountId: string | null = null;
    let spaceId: string | null = null;
    let pageId: string | null = null;

    try {
      const account = await prisma.account.create({
        data: {
          provider: 'email',
          providerUserId: `server-wiki-${unique}`,
          email: `server-wiki-${unique}@example.com`,
          displayName: `ServerWiki_${unique}`,
          emailVerified: true
        }
      });
      accountId = account.id;

      const server = await service.register({
        name: `Wiki Link ${unique.slice(0, 6)}`,
        joinHost: `wiki-${unique}.example.com`,
        joinPort: 25565,
        edition: 'java',
        supportedVersions: ['1.20.1'],
        tags: ['survival'],
        shortDescription: 'Server wiki link test',
        longDescription: 'Server wiki link integration test',
        websiteUrl: null,
        discordUrl: null,
        ownerAccountId: account.id
      });
      serverId = server.id;

      const link = await service.createServerWiki(server.id, account.id);
      spaceId = link.wikiSpaceId;
      pageId = link.wikiPageId;

      assert.equal(link.status, 'linked');
      assert.equal(link.serverId, server.id);
      assert.ok(link.serverWikiId);
      assert.ok(link.wikiSpaceId);
      assert.ok(link.wikiPageId);
      assert.ok(link.wikiSlug);
      assert.equal(link.wikiUrl, `/server/${encodeURIComponent(link.wikiSlug ?? '')}`);

      const detail = await service.detail(server.id);
      assert.equal(detail.wikiSpaceId, link.wikiSpaceId);
      assert.equal(detail.wikiPageId, link.wikiPageId);
      assert.equal(detail.wikiSlug, link.wikiSlug);

      const serverWiki = await prisma.serverWiki.findUnique({
        where: { voteServerId: server.id }
      });
      assert.equal(serverWiki?.slug, link.wikiSlug);
    } finally {
      if (serverId) {
        await prisma.server.update({
          where: { id: serverId },
          data: { wikiSpaceId: null, wikiPageId: null, wikiSlug: null }
        }).catch(() => {});
      }
      if (pageId) {
        const parsedPageId = BigInt(pageId);
        await prisma.wikiRecentChange.deleteMany({ where: { pageId: parsedPageId } });
        await prisma.wikiPageRenderCache.deleteMany({ where: { pageId: parsedPageId } });
        await prisma.wikiPageRevision.deleteMany({ where: { pageId: parsedPageId } });
        await prisma.wikiPage.delete({ where: { id: parsedPageId } }).catch(() => {});
      }
      if (spaceId) {
        const parsedSpaceId = BigInt(spaceId);
        await prisma.serverWiki.deleteMany({ where: { spaceId: parsedSpaceId } });
        await prisma.wikiSpace.delete({ where: { id: parsedSpaceId } }).catch(() => {});
      }
      if (serverId) {
        await prisma.server.delete({ where: { id: serverId } }).catch(() => {});
      }
      if (accountId) {
        await prisma.wikiProfile.deleteMany({ where: { accountId } });
        await prisma.account.delete({ where: { id: accountId } }).catch(() => {});
      }
      cleanup();
    }
  });

  test('updates returns timeline entries from live server activity', async () => {
    const { service, cleanup } = createService();
    const unique = randomUUID().slice(0, 8);
    let serverId: string | null = null;
    let accountId: string | null = null;

    try {
      const server = await service.register({
        name: `Update Test ${unique}`,
        joinHost: `updates-${unique}.example.com`,
        joinPort: 25565,
        edition: 'java',
        supportedVersions: ['1.20.1'],
        tags: ['survival'],
        shortDescription: 'Update timeline server',
        longDescription: 'Update timeline details',
        websiteUrl: null,
        discordUrl: null
      });
      serverId = server.id;

      const account = await prisma.account.create({
        data: {
          provider: 'email',
          providerUserId: `update-user-${unique}`,
          email: `update-${unique}@example.com`,
          displayName: `Updater_${unique}`,
          emailVerified: true
        }
      });
      accountId = account.id;

      await prisma.serverReview.create({
        data: {
          serverId: server.id,
          authorAccountId: account.id,
          authorDisplayName: `Updater_${unique}`,
          rating: 5,
          body: '업데이트 테스트 리뷰입니다.',
          tags: ['performance'],
          visibility: 'public',
          isAnonymous: false
        }
      });

      await prisma.vote.create({
        data: {
          serverId: server.id,
          username: `Player_${unique}`,
          usernameNormalized: `player_${unique}`.toLowerCase(),
          votedAt: new Date()
        }
      });

      const updates = await service.updates(server.id, 10);

      assert.ok(updates.length > 0);
      assert.ok(updates.some((entry) => entry.type === 'review'));
      assert.ok(updates.some((entry) => entry.type === 'vote'));
    } finally {
      if (serverId) {
        await prisma.server.delete({ where: { id: serverId } }).catch(() => {});
      }
      if (accountId) {
        await prisma.account.delete({ where: { id: accountId } }).catch(() => {});
      }
      cleanup();
    }
  });
}
