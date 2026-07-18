import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { WikiLinkIndexService } from './wiki-link-index.service';
import { WikiPageSwapService } from './wiki-page-swap.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';

test('real database atomically exchanges occupied paths and rebuilds derived records', {
  skip: process.env.DATABASE_URL?.trim() ? false : 'DATABASE_URL is not configured.',
}, async () => {
  const prisma = new PrismaService();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const now = new Date();
  await prisma.$connect();
  const profile = await prisma.wikiProfile.create({
    data: { username: `swap_${suffix}`, displayName: 'Swap integration', status: 'active', createdAt: now, updatedAt: now },
  });
  const namespace = await prisma.wikiNamespace.create({
    data: { code: `swp_${suffix}`, displayName: 'Swap integration', pathPrefix: `swp-${suffix}` },
  });
  const space = await prisma.wikiSpace.create({
    data: {
      code: `swap-${suffix}`, name: 'Swap integration', title: 'Swap integration',
      rootNamespaceCode: namespace.code, rootPath: `swap-${suffix}`, status: 'active',
      createdAt: now, updatedAt: now,
    },
  });
  const pages = await Promise.all([
    prisma.wikiPage.create({ data: {
      namespaceId: namespace.id, spaceId: space.id, localPath: `source-${suffix}`, slug: `source-${suffix}`,
      title: `Source ${suffix}`, displayTitle: `Source ${suffix}`, createdBy: profile.id,
      status: 'normal', pageType: 'article', protectionLevel: 'open', createdAt: now, updatedAt: now,
    } }),
    prisma.wikiPage.create({ data: {
      namespaceId: namespace.id, spaceId: space.id, localPath: `target-${suffix}`, slug: `target-${suffix}`,
      title: `Target ${suffix}`, displayTitle: `Target ${suffix}`, createdBy: profile.id,
      status: 'normal', pageType: 'article', protectionLevel: 'open', createdAt: now, updatedAt: now,
    } }),
  ]);
  const [source, target] = pages;
  assert.ok(source && target);
  const sourceRaw = '[[./relative-child]] source body';
  const targetRaw = 'target body';
  const revisions = await Promise.all([
    prisma.wikiPageRevision.create({ data: {
      pageId: source.id, revisionNo: 1, contentRaw: sourceRaw,
      contentHash: createHash('sha256').update(sourceRaw).digest('hex'), contentSize: Buffer.byteLength(sourceRaw),
      createdBy: profile.id, actorType: 'user', actorUserId: profile.id, createdAt: now, visibility: 'public',
    } }),
    prisma.wikiPageRevision.create({ data: {
      pageId: target.id, revisionNo: 1, contentRaw: targetRaw,
      contentHash: createHash('sha256').update(targetRaw).digest('hex'), contentSize: Buffer.byteLength(targetRaw),
      createdBy: profile.id, actorType: 'user', actorUserId: profile.id, createdAt: now, visibility: 'public',
    } }),
  ]);
  const [sourceRevision, targetRevision] = revisions;
  assert.ok(sourceRevision && targetRevision);
  await Promise.all([
    prisma.wikiPage.update({ where: { id: source.id }, data: { currentRevisionId: sourceRevision.id } }),
    prisma.wikiPage.update({ where: { id: target.id }, data: { currentRevisionId: targetRevision.id } }),
  ]);

  const profiles = { async ensureWikiProfile() { return profile; } } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: `swap-${suffix}`, profileId: profile.id, status: 'active' }; },
    async assertCanReadPage() {},
    async assertCanMutatePageAction() {},
    async assertCanCreatePage() {},
  } as unknown as WikiPermissionService;
  const service = new WikiPageSwapService(prisma, profiles, permissions, new WikiLinkIndexService());
  try {
    const result = await service.swap({ userId: `swap-${suffix}` } as SessionPayload, source.id.toString(), {
      targetPageId: target.id.toString(),
      expectedSourceRevisionId: sourceRevision.id.toString(),
      expectedTargetRevisionId: targetRevision.id.toString(),
      reason: 'real database atomic swap integration',
      sourceTitleConfirmation: source.title,
      targetTitleConfirmation: target.title,
    });
    assert.equal(result.source.slug, target.slug);
    assert.equal(result.target.slug, source.slug);

    const [storedSource, storedTarget, changes, audits, sourceLinks, searchDocuments] = await Promise.all([
      prisma.wikiPage.findUniqueOrThrow({ where: { id: source.id } }),
      prisma.wikiPage.findUniqueOrThrow({ where: { id: target.id } }),
      prisma.wikiRecentChange.findMany({ where: { pageId: { in: [source.id, target.id] }, changeType: 'move' } }),
      prisma.auditEvent.findMany({ where: { action: 'wiki.swap', subjectId: source.id.toString() } }),
      prisma.wikiPageLink.findMany({ where: { sourcePageId: source.id } }),
      prisma.wikiSearchDocument.findMany({ where: { pageId: { in: [source.id, target.id] } } }),
    ]);
    assert.equal(storedSource.localPath, target.localPath);
    assert.equal(storedTarget.localPath, source.localPath);
    assert.equal(storedSource.currentRevisionId, sourceRevision.id);
    assert.equal(storedTarget.currentRevisionId, targetRevision.id);
    assert.equal(changes.length, 2);
    assert.equal(audits.length, 1);
    assert.equal(sourceLinks[0]?.targetSlug, './relative-child');
    assert.equal(sourceLinks[0]?.sourceRevisionId, sourceRevision.id);
    assert.equal(searchDocuments.length, 2);
  } finally {
    await prisma.wikiPageLink.deleteMany({ where: { sourcePageId: { in: [source.id, target.id] } } });
    await prisma.wikiSearchDocument.deleteMany({ where: { pageId: { in: [source.id, target.id] } } });
    await prisma.wikiRecentChange.deleteMany({ where: { pageId: { in: [source.id, target.id] } } });
    await prisma.auditEvent.deleteMany({ where: { action: 'wiki.swap', subjectId: source.id.toString() } });
    await prisma.wikiPage.updateMany({ where: { id: { in: [source.id, target.id] } }, data: { currentRevisionId: null } });
    await prisma.wikiPageRevision.deleteMany({ where: { pageId: { in: [source.id, target.id] } } });
    await prisma.wikiPage.deleteMany({ where: { id: { in: [source.id, target.id] } } });
    await prisma.wikiSpace.delete({ where: { id: space.id } });
    await prisma.wikiNamespace.delete({ where: { id: namespace.id } });
    await prisma.wikiProfile.delete({ where: { id: profile.id } });
    await prisma.$disconnect();
  }
});
