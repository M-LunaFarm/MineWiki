import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { WikiLinkIndexService } from './wiki-link-index.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiUsernameService } from './wiki-username.service';

test('real database renames a Wiki identity, its document tree, and pending create target atomically', {
  skip: process.env.DATABASE_URL?.trim() ? false : 'DATABASE_URL is not configured.',
}, async () => {
  const prisma = new PrismaService();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const accountId = randomUUID();
  const oldUsername = `old_${suffix}`;
  const newUsername = `new_${suffix}`;
  const now = new Date();
  await prisma.$connect();
  let namespace = await prisma.wikiNamespace.findUnique({ where: { code: 'user' } });
  const createdNamespace = namespace === null;
  namespace ??= await prisma.wikiNamespace.create({
    data: { code: 'user', displayName: '사용자', pathPrefix: 'user', isContent: true },
  });
  const account = await prisma.account.create({ data: {
    id: accountId, canonicalAccountId: accountId, provider: 'discord',
    providerUserId: `rename-${suffix}`, displayName: 'Rename integration', lifecycleStatus: 'active',
  } });
  const profile = await prisma.wikiProfile.create({ data: {
    accountId: account.id, username: oldUsername, displayName: 'Rename integration', status: 'active',
    createdAt: now, updatedAt: now,
  } });
  const space = await prisma.wikiSpace.create({ data: {
    code: `rename-${suffix}`, name: 'Rename integration', title: 'Rename integration',
    rootNamespaceCode: 'user', rootPath: `rename-${suffix}`, status: 'active', createdAt: now, updatedAt: now,
  } });
  const root = await prisma.wikiPage.create({ data: {
    namespaceId: namespace.id, spaceId: space.id, localPath: oldUsername, slug: oldUsername,
    title: oldUsername, displayTitle: oldUsername, ownerProfileId: profile.id, createdBy: profile.id,
    pageType: 'article', protectionLevel: 'open', status: 'normal', createdAt: now, updatedAt: now,
  } });
  const child = await prisma.wikiPage.create({ data: {
    namespaceId: namespace.id, spaceId: space.id, localPath: `${oldUsername}/guide`, slug: `${oldUsername}/guide`,
    title: `${oldUsername}/guide`, displayTitle: `${oldUsername}/guide`, ownerProfileId: profile.id, createdBy: profile.id,
    pageType: 'article', protectionLevel: 'open', status: 'normal', createdAt: now, updatedAt: now,
  } });
  const rootRaw = 'root body';
  const childRaw = '[[./child]] child body';
  const rootRevision = await prisma.wikiPageRevision.create({ data: {
    pageId: root.id, revisionNo: 1, contentRaw: rootRaw,
    contentHash: createHash('sha256').update(rootRaw).digest('hex'), contentSize: Buffer.byteLength(rootRaw),
    createdBy: profile.id, actorType: 'user', actorUserId: profile.id, createdAt: now, visibility: 'public',
  } });
  const childRevision = await prisma.wikiPageRevision.create({ data: {
    pageId: child.id, revisionNo: 1, contentRaw: childRaw,
    contentHash: createHash('sha256').update(childRaw).digest('hex'), contentSize: Buffer.byteLength(childRaw),
    createdBy: profile.id, actorType: 'user', actorUserId: profile.id, createdAt: now, visibility: 'public',
  } });
  await Promise.all([
    prisma.wikiPage.update({ where: { id: root.id }, data: { currentRevisionId: rootRevision.id } }),
    prisma.wikiPage.update({ where: { id: child.id }, data: { currentRevisionId: childRevision.id } }),
  ]);
  const pending = await prisma.wikiEditRequest.create({ data: {
    requestKind: 'create', targetNamespaceId: namespace.id, targetNamespaceCode: 'user',
    targetSpaceId: space.id, targetTitle: `${oldUsername}/draft`, targetSlug: `${oldUsername}/draft`,
    targetDisplayTitle: `${oldUsername}/draft`, targetPageType: 'article', targetOwnerProfileId: profile.id,
    proposedContent: 'draft', editSummary: 'rename integration', status: 'pending', createdBy: profile.id,
    createdAt: now, updatedAt: now,
  } });
  const service = new WikiUsernameService(prisma, new WikiProfileService(prisma), new WikiLinkIndexService());
  try {
    const result = await service.change({ userId: account.id, authenticatedAt: now.toISOString() } as SessionPayload, {
      username: newUsername,
      confirmation: oldUsername,
    });
    assert.equal(result.previousUsername, oldUsername);
    assert.equal(result.username, newUsername);
    assert.equal(result.movedDocumentCount, 2);
    assert.equal(result.canChange, false);

    const [storedProfile, storedPages, storedPending, alias, changes, audits, searchDocuments] = await Promise.all([
      prisma.wikiProfile.findUniqueOrThrow({ where: { id: profile.id } }),
      prisma.wikiPage.findMany({ where: { id: { in: [root.id, child.id] } }, orderBy: { id: 'asc' } }),
      prisma.wikiEditRequest.findUniqueOrThrow({ where: { id: pending.id } }),
      prisma.wikiUsernameAlias.findUnique({ where: { oldUsername } }),
      prisma.wikiRecentChange.findMany({ where: { pageId: { in: [root.id, child.id] }, changeType: 'move' } }),
      prisma.auditEvent.findMany({ where: { action: 'wiki.profile.rename', subjectId: profile.id.toString() } }),
      prisma.wikiSearchDocument.findMany({ where: { pageId: { in: [root.id, child.id] } } }),
    ]);
    assert.equal(storedProfile.username, newUsername);
    assert.ok(storedProfile.usernameChangedAt);
    assert.deepEqual(storedPages.map((page) => page.localPath).sort(), [newUsername, `${newUsername}/guide`].sort());
    assert.equal(storedPending.targetTitle, `${newUsername}/draft`);
    assert.equal(storedPending.targetSlug, `${newUsername}/draft`);
    assert.equal(alias?.profileId, profile.id);
    assert.equal(changes.length, 2);
    assert.equal(audits.length, 1);
    assert.equal(searchDocuments.length, 2);
  } finally {
    await prisma.wikiEditRequest.deleteMany({ where: { id: pending.id } });
    await prisma.wikiPageLink.deleteMany({ where: { sourcePageId: { in: [root.id, child.id] } } });
    await prisma.wikiSearchDocument.deleteMany({ where: { pageId: { in: [root.id, child.id] } } });
    await prisma.wikiRecentChange.deleteMany({ where: { pageId: { in: [root.id, child.id] } } });
    await prisma.auditEvent.deleteMany({ where: { action: 'wiki.profile.rename', subjectId: profile.id.toString() } });
    await prisma.wikiUsernameAlias.deleteMany({ where: { profileId: profile.id } });
    await prisma.wikiPage.updateMany({ where: { id: { in: [root.id, child.id] } }, data: { currentRevisionId: null } });
    await prisma.wikiPageRevision.deleteMany({ where: { pageId: { in: [root.id, child.id] } } });
    await prisma.wikiPage.deleteMany({ where: { id: { in: [root.id, child.id] } } });
    await prisma.wikiSpace.delete({ where: { id: space.id } });
    if (createdNamespace) await prisma.wikiNamespace.delete({ where: { id: namespace.id } });
    await prisma.wikiProfile.delete({ where: { id: profile.id } });
    await prisma.account.delete({ where: { id: account.id } });
    await prisma.$disconnect();
  }
});
