import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ServerService } from './server.service';
import { UploadService } from '../upload/upload.service';
import { PrismaService } from '../common/prisma.service';
import type { ConfigService } from '@minewiki/config';
import { WikiProfileService } from '../wiki/wiki-profile.service';
import { FileService } from '../file/file.service';

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
    const fileService = new FileService(prisma, uploadService);
    const service = new ServerService(fileService, prisma, wikiProfiles);
    return {
      service,
      cleanup: () => rmSync(storageRoot, { recursive: true, force: true })
    };
  }

  test('updateBanner stores sanitized image and updates server detail', async () => {
    const { service, cleanup } = createService();
    let serverId: string | null = null;
    let uploadedFileId: string | null = null;
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
      serverId = server.id;

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

      const stored = await service.updateBanner(server.id, randomUUID(), {
        data: `data:image/jpeg;base64,${buffer.toString('base64')}`,
        filename: 'banner.jpg'
      });
      uploadedFileId = stored.id;

      const detail = await service.detail(server.id);
      assert.equal(detail.bannerUrl, stored.publicPath);
      assert.ok(stored.filename.endsWith('.webp'));
      assert.ok(stored.width <= 800);
    } finally {
      if (uploadedFileId) {
        await prisma.uploadedFile.delete({ where: { id: uploadedFileId } }).catch(() => {});
      }
      if (serverId) {
        await prisma.server.delete({ where: { id: serverId } }).catch(() => {});
      }
      cleanup();
    }
  });

  test('uploadContentImage stores sanitized image for markdown content', async () => {
    const { service, cleanup } = createService();
    let uploadedFileId: string | null = null;
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

      const stored = await service.uploadContentImage(randomUUID(), {
        data: `data:image/png;base64,${buffer.toString('base64')}`,
        filename: 'content.png'
      });
      uploadedFileId = stored.id;
      assert.ok(stored.publicPath.length > 0);
      assert.ok(stored.filename.endsWith('.webp'));
      assert.ok(stored.width <= 1200);
    } finally {
      if (uploadedFileId) {
        await prisma.uploadedFile.delete({ where: { id: uploadedFileId } }).catch(() => {});
      }
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
      const storedServer = await prisma.server.findUnique({ where: { id: server.id } });
      assert.equal(typeof storedServer?.wikiSpaceId, 'bigint');
      assert.equal(typeof storedServer?.wikiPageId, 'bigint');

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
      if (spaceId) {
        const parsedSpaceId = BigInt(spaceId);
        const pages = await prisma.wikiPage.findMany({
          where: { spaceId: parsedSpaceId },
          select: { id: true }
        });
        const pageIds = pages.map((page) => page.id);
        if (pageIds.length > 0) {
          await prisma.wikiPageLink.deleteMany({ where: { sourcePageId: { in: pageIds } } });
          await prisma.wikiRecentChange.deleteMany({ where: { pageId: { in: pageIds } } });
          await prisma.wikiPageRenderCache.deleteMany({ where: { pageId: { in: pageIds } } });
          await prisma.wikiPageRevision.deleteMany({ where: { pageId: { in: pageIds } } });
          await prisma.wikiPage.deleteMany({ where: { id: { in: pageIds } } });
        }
        assert.equal(await prisma.wikiPage.count({ where: { spaceId: parsedSpaceId } }), 0);
        await prisma.serverWiki.deleteMany({ where: { spaceId: parsedSpaceId } });
        await prisma.wikiSpace.delete({ where: { id: parsedSpaceId } }).catch(() => {});
      } else if (pageId) {
        const parsedPageId = BigInt(pageId);
        await prisma.wikiPageLink.deleteMany({ where: { sourcePageId: parsedPageId } });
        await prisma.wikiRecentChange.deleteMany({ where: { pageId: parsedPageId } });
        await prisma.wikiPageRenderCache.deleteMany({ where: { pageId: parsedPageId } });
        await prisma.wikiPageRevision.deleteMany({ where: { pageId: parsedPageId } });
        await prisma.wikiPage.delete({ where: { id: parsedPageId } }).catch(() => {});
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
      await prisma.serverReview.create({
        data: {
          serverId: server.id,
          authorAccountId: account.id,
          authorDisplayName: `Hidden_${unique}`,
          rating: 1,
          body: '관리자에게만 보여야 하는 숨김 리뷰입니다.',
          tags: ['other'],
          visibility: 'staff',
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
      await prisma.vote.create({
        data: {
          serverId: server.id,
          username: `Invalid_${unique}`,
          usernameNormalized: `invalid_${unique}`.toLowerCase(),
          status: 'invalid',
          votedAt: new Date()
        }
      });

      const updates = await service.updates(server.id, 10);

      assert.ok(updates.length > 0);
      assert.ok(updates.some((entry) => entry.type === 'review'));
      assert.equal(
        updates.some((entry) => entry.description.includes('관리자에게만 보여야 하는 숨김 리뷰')),
        false
      );
      assert.ok(updates.some((entry) => entry.type === 'vote'));
      assert.ok(
        updates.some((entry) => entry.type === 'vote' && entry.description.includes('1회 투표'))
      );
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

  test('server wiki linking enforces tenant ownership and admits only one concurrent claimant', async () => {
    const { service, cleanup } = createService();
    const unique = randomUUID().replace(/-/g, '').slice(0, 12);
    const serverIds: string[] = [];
    const accountIds: string[] = [];
    let spaceId: bigint | null = null;

    try {
      const owner = await prisma.account.create({
        data: {
          provider: 'email',
          providerUserId: `link-owner-${unique}`,
          email: `link-owner-${unique}@example.com`,
          displayName: `LinkOwner_${unique}`,
          emailVerified: true,
        },
      });
      const foreignOwner = await prisma.account.create({
        data: {
          provider: 'email',
          providerUserId: `link-foreign-${unique}`,
          email: `link-foreign-${unique}@example.com`,
          displayName: `LinkForeign_${unique}`,
          emailVerified: true,
        },
      });
      accountIds.push(owner.id, foreignOwner.id);
      const ownerProfile = await wikiProfiles.ensureWikiProfile(owner.id);

      const space = await prisma.wikiSpace.create({
        data: {
          code: `link-space-${unique}`,
          spaceKey: `link-space-${unique}`,
          name: `Link Space ${unique}`,
          title: `Link Space ${unique}`,
          slug: `link-space-${unique}`,
          spaceType: 'server_wiki',
          rootNamespaceCode: 'server',
          rootPath: `/server/link-space-${unique}`,
          status: 'active',
          createdBy: ownerProfile.id,
          ownerUserId: ownerProfile.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      spaceId = space.id;
      const target = await prisma.serverWiki.create({
        data: {
          spaceId: space.id,
          serverName: `Unlinked ${unique}`,
          slug: `link-space-${unique}`,
          status: 'active',
          createdBy: ownerProfile.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      const registerOwnedServer = async (suffix: string, ownerAccountId: string) => {
        const server = await service.register({
          name: `Link ${suffix} ${unique}`,
          joinHost: `link-${suffix}-${unique}.example.com`,
          joinPort: 25565,
          edition: 'java',
          supportedVersions: ['1.21'],
          tags: ['test'],
          shortDescription: `Link ${suffix} test`,
          longDescription: `Link ${suffix} transaction test`,
          websiteUrl: null,
          discordUrl: null,
          ownerAccountId,
        });
        serverIds.push(server.id);
        return server;
      };
      const first = await registerOwnedServer('first', owner.id);
      const second = await registerOwnedServer('second', owner.id);
      const foreign = await registerOwnedServer('foreign', foreignOwner.id);

      await assert.rejects(
        () => service.linkServerWiki(
          foreign.id,
          { serverWikiId: target.id.toString() },
          foreignOwner.id,
        ),
        /target.*wiki/u,
      );

      const outcomes = await Promise.allSettled([
        service.linkServerWiki(first.id, { wikiSlug: target.slug }, owner.id),
        service.linkServerWiki(second.id, { spaceId: space.id.toString() }, owner.id),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);

      const storedTarget = await prisma.serverWiki.findUnique({ where: { id: target.id } });
      assert.ok(storedTarget?.voteServerId === first.id || storedTarget?.voteServerId === second.id);
      const linkedServers = await prisma.server.count({
        where: { wikiSpaceId: space.id },
      });
      assert.equal(linkedServers, 1);
      const linkAudits = await prisma.auditEvent.findMany({
        where: {
          action: 'server.wiki.link',
          subjectType: 'server',
          subjectId: { in: serverIds },
        },
      });
      assert.equal(linkAudits.length, 1);
      assert.equal(linkAudits[0]?.actorAccountId, owner.id);
      assert.deepEqual(
        Object.keys(linkAudits[0]?.metadata as Record<string, unknown>).sort(),
        ['serverId', 'serverWikiId', 'wikiPageId', 'wikiSlug', 'wikiSpaceId'],
      );
    } finally {
      if (serverIds.length > 0) {
        await prisma.auditEvent.deleteMany({
          where: { action: 'server.wiki.link', subjectId: { in: serverIds } },
        }).catch(() => {});
      }
      if (serverIds.length > 0) {
        await prisma.server.updateMany({
          where: { id: { in: serverIds } },
          data: { wikiSpaceId: null, wikiPageId: null, wikiSlug: null },
        }).catch(() => {});
      }
      if (spaceId) {
        await prisma.serverWiki.deleteMany({ where: { spaceId } }).catch(() => {});
        await prisma.wikiSpace.delete({ where: { id: spaceId } }).catch(() => {});
      }
      if (serverIds.length > 0) {
        await prisma.server.deleteMany({ where: { id: { in: serverIds } } }).catch(() => {});
      }
      if (accountIds.length > 0) {
        await prisma.wikiProfile.deleteMany({ where: { accountId: { in: accountIds } } }).catch(() => {});
        await prisma.account.deleteMany({ where: { id: { in: accountIds } } }).catch(() => {});
      }
      cleanup();
    }
  });

  test('server deletion archives only its wiki, preserves content, revokes collaborators, and rolls back when audit fails', async () => {
    const { service, cleanup } = createService();
    const unique = randomUUID().replace(/-/g, '').slice(0, 12);
    const triggerName = `server_delete_audit_${unique}`;
    const accountIds: string[] = [];
    const spaceIds: bigint[] = [];
    let serverId: string | null = null;
    let pageId: bigint | null = null;
    let revisionId: bigint | null = null;
    let triggerCreated = false;

    try {
      const owner = await prisma.account.create({
        data: {
          provider: 'email',
          providerUserId: `delete-owner-${unique}`,
          email: `delete-owner-${unique}@example.com`,
          displayName: `DeleteOwner_${unique}`,
          emailVerified: true,
        },
      });
      const collaborator = await prisma.account.create({
        data: {
          provider: 'email',
          providerUserId: `delete-collaborator-${unique}`,
          email: `delete-collaborator-${unique}@example.com`,
          displayName: `DeleteCollaborator_${unique}`,
          emailVerified: true,
        },
      });
      accountIds.push(owner.id, collaborator.id);
      const ownerProfile = await wikiProfiles.ensureWikiProfile(owner.id);
      const collaboratorProfile = await wikiProfiles.ensureWikiProfile(collaborator.id);
      const namespace = await prisma.wikiNamespace.upsert({
        where: { code: 'server' },
        update: {},
        create: { code: 'server', displayName: '서버', pathPrefix: 'server', isContent: true },
      });
      const now = new Date();
      const space = await prisma.wikiSpace.create({
        data: {
          code: `delete-space-${unique}`,
          spaceKey: `delete-space-${unique}`,
          name: `Delete Space ${unique}`,
          title: `Delete Space ${unique}`,
          slug: `delete-space-${unique}`,
          spaceType: 'server_wiki',
          rootNamespaceCode: 'server',
          rootPath: `/server/delete-space-${unique}`,
          status: 'active',
          createdBy: ownerProfile.id,
          ownerUserId: ownerProfile.id,
          createdAt: now,
          updatedAt: now,
        },
      });
      const foreignSpace = await prisma.wikiSpace.create({
        data: {
          code: `foreign-delete-space-${unique}`,
          spaceKey: `foreign-delete-space-${unique}`,
          name: `Foreign Delete Space ${unique}`,
          title: `Foreign Delete Space ${unique}`,
          slug: `foreign-delete-space-${unique}`,
          spaceType: 'server_wiki',
          rootNamespaceCode: 'server',
          rootPath: `/server/foreign-delete-space-${unique}`,
          status: 'active',
          createdBy: ownerProfile.id,
          ownerUserId: ownerProfile.id,
          createdAt: now,
          updatedAt: now,
        },
      });
      spaceIds.push(space.id, foreignSpace.id);
      const page = await prisma.wikiPage.create({
        data: {
          namespaceId: namespace.id,
          spaceId: space.id,
          localPath: '',
          slug: `delete-space-${unique}`,
          title: `delete-space-${unique}`,
          displayTitle: `Delete Space ${unique}`,
          pageType: 'server',
          status: 'normal',
          createdBy: ownerProfile.id,
          createdAt: now,
          updatedAt: now,
        },
      });
      pageId = page.id;
      const revision = await prisma.wikiPageRevision.create({
        data: {
          pageId: page.id,
          revisionNo: 1,
          contentRaw: '# Preserved server history',
          contentAst: {},
          contentHash: 'a'.repeat(64),
          contentSize: 26,
          editSummary: 'Deletion lifecycle fixture',
          createdBy: ownerProfile.id,
          actorUserId: ownerProfile.id,
          createdAt: now,
          visibility: 'public',
        },
      });
      revisionId = revision.id;
      await prisma.wikiPage.update({
        where: { id: page.id },
        data: { currentRevisionId: revision.id },
      });
      await prisma.wikiSpace.update({
        where: { id: space.id },
        data: { rootPageId: page.id },
      });

      const server = await service.register({
        name: `Delete Server ${unique}`,
        joinHost: `delete-${unique}.example.com`,
        joinPort: 25565,
        edition: 'java',
        supportedVersions: ['1.21'],
        tags: ['test'],
        shortDescription: 'Server deletion lifecycle test',
        longDescription: 'Server deletion lifecycle transaction test',
        websiteUrl: null,
        discordUrl: null,
        ownerAccountId: owner.id,
      });
      serverId = server.id;
      const serverWiki = await prisma.serverWiki.create({
        data: {
          spaceId: space.id,
          voteServerId: server.id,
          serverName: server.name,
          slug: `delete-space-${unique}`,
          status: 'active',
          createdBy: ownerProfile.id,
          createdAt: now,
          updatedAt: now,
        },
      });
      const foreignWiki = await prisma.serverWiki.create({
        data: {
          spaceId: foreignSpace.id,
          serverName: `Foreign Delete Wiki ${unique}`,
          slug: `foreign-delete-space-${unique}`,
          status: 'active',
          createdBy: ownerProfile.id,
          createdAt: now,
          updatedAt: now,
        },
      });
      await prisma.server.update({
        where: { id: server.id },
        data: { wikiSpaceId: space.id, wikiPageId: page.id, wikiSlug: serverWiki.slug },
      });
      await prisma.subwikiRole.createMany({
        data: [
          {
            spaceId: space.id,
            userId: ownerProfile.id,
            role: 'owner',
            status: 'active',
            grantedBy: ownerProfile.id,
            grantedAt: now,
          },
          {
            spaceId: space.id,
            userId: collaboratorProfile.id,
            role: 'manager',
            status: 'active',
            grantedBy: ownerProfile.id,
            grantedAt: now,
          },
          {
            spaceId: foreignSpace.id,
            userId: collaboratorProfile.id,
            role: 'manager',
            status: 'active',
            grantedBy: ownerProfile.id,
            grantedAt: now,
          },
        ],
      });
      const pluginCredential = await prisma.pluginServer.create({
        data: {
          serverId: server.id,
          guildId: `delete-guild-${unique}`,
          pluginServerId: `delete-plugin-${unique}`,
          serverName: server.name,
          host: server.joinHost,
          port: server.joinPort,
          serverSecret: 'test-secret',
          enabled: true,
        },
      });

      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER \`${triggerName}\`
        BEFORE INSERT ON audit_events
        FOR EACH ROW
        BEGIN
          IF NEW.action = 'server.deleted' AND NEW.subject_id = '${server.id}' THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced server deletion audit failure';
          END IF;
        END
      `);
      triggerCreated = true;
      await assert.rejects(
        () => service.remove(server.id, owner.id),
        /forced server deletion audit failure/u,
      );

      assert.ok(await prisma.server.findUnique({ where: { id: server.id } }));
      assert.equal((await prisma.serverWiki.findUnique({ where: { id: serverWiki.id } }))?.status, 'active');
      assert.equal((await prisma.serverWiki.findUnique({ where: { id: serverWiki.id } }))?.voteServerId, server.id);
      assert.equal((await prisma.wikiSpace.findUnique({ where: { id: space.id } }))?.status, 'active');
      assert.equal((await prisma.subwikiRole.findUnique({
        where: { spaceId_userId_role: { spaceId: space.id, userId: collaboratorProfile.id, role: 'manager' } },
      }))?.status, 'active');
      assert.equal((await prisma.pluginServer.findUnique({ where: { id: pluginCredential.id } }))?.enabled, true);

      await prisma.$executeRawUnsafe(`DROP TRIGGER \`${triggerName}\``);
      triggerCreated = false;
      await service.remove(server.id, owner.id);

      assert.equal(await prisma.server.findUnique({ where: { id: server.id } }), null);
      const archivedWiki = await prisma.serverWiki.findUnique({ where: { id: serverWiki.id } });
      assert.equal(archivedWiki?.status, 'archived');
      assert.equal(archivedWiki?.voteServerId, null);
      assert.equal((await prisma.wikiSpace.findUnique({ where: { id: space.id } }))?.status, 'archived');
      assert.equal((await prisma.subwikiRole.findUnique({
        where: { spaceId_userId_role: { spaceId: space.id, userId: ownerProfile.id, role: 'owner' } },
      }))?.status, 'active');
      const revokedCollaborator = await prisma.subwikiRole.findUnique({
        where: { spaceId_userId_role: { spaceId: space.id, userId: collaboratorProfile.id, role: 'manager' } },
      });
      assert.equal(revokedCollaborator?.status, 'revoked');
      assert.equal(revokedCollaborator?.revokedBy, ownerProfile.id);
      assert.ok(await prisma.wikiPage.findUnique({ where: { id: page.id } }));
      assert.ok(await prisma.wikiPageRevision.findUnique({ where: { id: revision.id } }));
      assert.equal((await prisma.serverWiki.findUnique({ where: { id: foreignWiki.id } }))?.status, 'active');
      assert.equal((await prisma.wikiSpace.findUnique({ where: { id: foreignSpace.id } }))?.status, 'active');
      assert.equal((await prisma.subwikiRole.findUnique({
        where: { spaceId_userId_role: { spaceId: foreignSpace.id, userId: collaboratorProfile.id, role: 'manager' } },
      }))?.status, 'active');
      assert.equal((await prisma.pluginServer.findUnique({ where: { id: pluginCredential.id } }))?.enabled, false);
      const audit = await prisma.auditEvent.findFirst({
        where: { action: 'server.deleted', subjectType: 'server', subjectId: server.id },
      });
      assert.equal(audit?.actorAccountId, owner.id);
      assert.deepEqual(audit?.metadata, {
        disabledPluginCredentials: 1,
        archivedServerWikiId: serverWiki.id.toString(),
        archivedWikiSpaceId: space.id.toString(),
        revokedCollaboratorMemberships: 1,
        preservedOwnerMemberships: 1,
      });
    } finally {
      if (triggerCreated) {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS \`${triggerName}\``).catch(() => {});
      }
      if (serverId) {
        await prisma.auditEvent.deleteMany({ where: { subjectId: serverId } }).catch(() => {});
        await prisma.pluginServer.deleteMany({ where: { serverId } }).catch(() => {});
        await prisma.server.deleteMany({ where: { id: serverId } }).catch(() => {});
      }
      if (spaceIds.length > 0) {
        await prisma.subwikiRole.deleteMany({ where: { spaceId: { in: spaceIds } } }).catch(() => {});
        await prisma.serverWiki.deleteMany({ where: { spaceId: { in: spaceIds } } }).catch(() => {});
      }
      if (revisionId) await prisma.wikiPageRevision.deleteMany({ where: { id: revisionId } }).catch(() => {});
      if (pageId) await prisma.wikiPage.deleteMany({ where: { id: pageId } }).catch(() => {});
      if (spaceIds.length > 0) await prisma.wikiSpace.deleteMany({ where: { id: { in: spaceIds } } }).catch(() => {});
      if (accountIds.length > 0) {
        await prisma.wikiProfile.deleteMany({ where: { accountId: { in: accountIds } } }).catch(() => {});
        await prisma.account.deleteMany({ where: { id: { in: accountIds } } }).catch(() => {});
      }
      cleanup();
    }
  });
}
