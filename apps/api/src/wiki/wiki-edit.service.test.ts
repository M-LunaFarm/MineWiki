import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { parseMarkup } from '@minewiki/wiki-core';
import { astContainsFile, categoryDocumentReferencesSelf, WikiEditService } from './wiki-edit.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiReadService } from './wiki-read.service';
import type { WikiNotificationService } from './wiki-notification.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

test('file dependencies are detected inside nested folding blocks', () => {
  assert.equal(astContainsFile(parseMarkup('일반 문서').ast), false);
  assert.equal(astContainsFile(parseMarkup('{{{#!folding 자세히\n[[파일:logo.png]]\n}}}').ast), true);
});

test('category documents cannot list themselves as a parent', () => {
  assert.equal(categoryDocumentReferencesSelf('category', '게임 플레이/몹', ['게임_플레이/몹']), true);
  assert.equal(categoryDocumentReferencesSelf('category', '게임 플레이/몹', ['게임 플레이']), false);
  assert.equal(categoryDocumentReferencesSelf('main', '게임 플레이/몹', ['게임 플레이/몹']), false);
});

function session(userId: string, isElevated = false) {
  return {
    sessionId: `test-session-${userId}`,
    userId,
    isElevated
  };
}

test('preview returns blocking markup errors', () => {
  const edits = new WikiEditService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);
  const preview = edits.preview('<script>alert(1)</script>');

  assert.ok(preview.blockingErrors.length > 0);
  assert.ok(preview.blockingErrors.some((error) => error.includes('HTML')));
});

test('revision source requires raw ACL while diff requires history ACL', async () => {
  const actions: string[] = [];
  const revision = {
    id: 11n,
    pageId: 7n,
    revisionNo: 1,
    parentRevisionId: null,
    contentRaw: '문서 내용',
    contentHash: 'a'.repeat(64),
    contentSize: 13,
    syntaxVersion: 'bwm-0.3',
    editSummary: null,
    isMinor: false,
    createdBy: 3n,
    actorUserId: 3n,
    createdAt: new Date('2026-07-13T00:00:00Z'),
    visibility: 'public'
  };
  const prisma = {
    wikiPageRevision: { async findUnique() { return revision; } },
    wikiPage: { async findUnique() { return { id: 7n, spaceId: 1n, title: '문서', protectionLevel: 'open', status: 'normal' }; } }
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadPage() {},
    async assertCanUsePageAction(input: { action: string }) { actions.push(input.action); }
  } as unknown as WikiPermissionService;
  const edits = new WikiEditService(prisma, {} as WikiProfileService, permissions);

  await edits.getRevision('11');
  await edits.getRevisionDiff('11', '11');

  assert.deepEqual(actions, ['raw', 'history', 'history']);
});

test('explicit spaces cannot cross namespace boundaries', async () => {
  const prisma = {
    wikiNamespace: { async findUnique() { return { id: 2, code: 'server' }; } },
    wikiSpace: { async findUnique() { return { id: 9n, status: 'active', spaceType: 'basic', rootNamespaceCode: 'main' }; } }
  } as unknown as PrismaService;
  const edits = new WikiEditService(prisma, {} as WikiProfileService, {} as WikiPermissionService);
  await assert.rejects(
    edits.createPage(session('account'), { namespace: 'server', title: 'other/규칙', spaceId: '9', contentRaw: '내용' }),
    /namespace does not belong/
  );
});

test('server wiki paths must stay inside the selected server slug', async () => {
  const prisma = {
    wikiNamespace: { async findUnique() { return { id: 2, code: 'server' }; } },
    wikiSpace: { async findUnique() { return { id: 9n, status: 'active', spaceType: 'server_wiki', rootNamespaceCode: 'server' }; } },
    serverWiki: { async findFirst() { return { slug: 'minewiki' }; } }
  } as unknown as PrismaService;
  const edits = new WikiEditService(prisma, {} as WikiProfileService, {} as WikiPermissionService);
  await assert.rejects(
    edits.createPage(session('account'), { namespace: 'server', title: 'other/규칙', spaceId: '9', contentRaw: '내용' }),
    /does not belong to this server/
  );
});

test('request page types cannot override the space invariant', async () => {
  const prisma = {
    wikiNamespace: { async findUnique() { return { id: 1, code: 'main' }; } },
    wikiSpace: { async findUnique() { return { id: 9n, status: 'active', spaceType: 'basic', rootNamespaceCode: 'main' }; } }
  } as unknown as PrismaService;
  const edits = new WikiEditService(prisma, {} as WikiProfileService, {} as WikiPermissionService);
  await assert.rejects(
    edits.createPage(session('account'), { namespace: 'main', title: '문서', spaceId: '9', pageType: 'server', contentRaw: '내용' }),
    /Page type must be article/
  );
});

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const profiles = new WikiProfileService(prisma);
  const permissions = new WikiPermissionService(prisma);
  const edits = new WikiEditService(prisma, profiles, permissions);
  const reads = new WikiReadService(prisma, permissions);

  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  async function createFixture() {
    const unique = randomUUID().replace(/-/g, '').slice(0, 16);
    const namespaceCode = `t${unique.slice(0, 12)}`;
    const account = await prisma.account.create({
      data: {
        provider: 'email',
        providerUserId: `wiki-edit-${unique}`,
        email: `wiki-edit-${unique}@example.com`,
        displayName: `WikiEditor_${unique}`,
        emailVerified: true
      }
    });
    const namespace = await prisma.wikiNamespace.create({
      data: {
        code: namespaceCode,
        displayName: `Test ${unique}`,
        pathPrefix: `/${namespaceCode}`,
        isContent: true
      }
    });
    const space = await prisma.wikiSpace.create({
      data: {
        code: `space-${unique}`,
        spaceKey: `space-${unique}`,
        name: `Space ${unique}`,
        title: `Space ${unique}`,
        slug: `space-${unique}`,
        spaceType: 'basic',
        rootNamespaceCode: namespace.code,
        rootPath: `/${namespace.code}`,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date()
      }
    });
    return { account, namespace, space, unique };
  }

  async function cleanupFixture(input: {
    accountId: string;
    namespaceId: number;
    namespaceCode: string;
    spaceId: bigint;
    pageId?: string;
  }) {
    const pageFilter = input.pageId ? { id: BigInt(input.pageId) } : { spaceId: input.spaceId };
    await prisma.wikiRecentChange.deleteMany(
      input.pageId ? { where: { pageId: BigInt(input.pageId) } } : { where: { namespaceCode: input.namespaceCode } }
    );
    const pages = await prisma.wikiPage.findMany({ where: pageFilter, select: { id: true } });
    for (const page of pages) {
      await prisma.pageSectionLock.deleteMany({ where: { pageId: page.id } });
      await prisma.wikiPageRenderCache.deleteMany({ where: { pageId: page.id } });
      await prisma.wikiPageRevision.deleteMany({ where: { pageId: page.id } });
      await prisma.wikiPage.delete({ where: { id: page.id } }).catch(() => {});
    }
    await prisma.wikiSpace.delete({ where: { id: input.spaceId } }).catch(() => {});
    await prisma.wikiNamespace.delete({ where: { id: input.namespaceId } }).catch(() => {});
    await prisma.wikiProfile.deleteMany({ where: { accountId: input.accountId } });
    await prisma.account.delete({ where: { id: input.accountId } }).catch(() => {});
  }

  test('creates a wiki page with compatible first revision and recent change', async () => {
    const fixture = await createFixture();
    let pageId: string | undefined;
    try {
      const created = await edits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code,
        title: `대문 ${fixture.unique}`,
        spaceId: fixture.space.id.toString(),
        contentRaw: `'''대문''' 내용`,
        editSummary: '처음 생성'
      });
      pageId = created.pageId;

      const revision = await edits.getRevision(created.revisionId);
      assert.equal(created.revisionNo, 1);
      assert.equal(revision.parentRevisionId, null);
      assert.equal(revision.editSummary, '처음 생성');
      assert.equal(revision.contentSize, Buffer.byteLength(`'''대문''' 내용`, 'utf8'));
      assert.match(revision.contentHash, /^[a-f0-9]{64}$/);
      assert.ok(revision.createdBy);
      assert.equal(revision.createdBy, revision.actorUserId);

      const recentChange = await prisma.wikiRecentChange.findFirst({
        where: { pageId: BigInt(created.pageId), revisionId: BigInt(created.revisionId) }
      });
      assert.equal(recentChange?.changeType, 'create');
      assert.equal(recentChange?.namespaceCode, fixture.namespace.code);
    } finally {
      await cleanupFixture({
        accountId: fixture.account.id,
        namespaceId: fixture.namespace.id,
        namespaceCode: fixture.namespace.code,
        spaceId: fixture.space.id,
        pageId
      });
    }
  });

  test('creates a server wiki child page in the owning server space', async () => {
    const unique = randomUUID().replace(/-/g, '').slice(0, 16);
    const serverSlug = `server-${unique}`;
    const account = await prisma.account.create({
      data: {
        provider: 'email',
        providerUserId: `server-wiki-child-${unique}`,
        email: `server-wiki-child-${unique}@example.com`,
        displayName: `ServerWiki_${unique}`,
        emailVerified: true,
      },
    });
    const profile = await profiles.ensureWikiProfile(account.id);
    const space = await prisma.wikiSpace.create({
      data: {
        code: `server-child-${unique}`,
        spaceKey: `server-child-${unique}`,
        name: `Server child ${unique}`,
        slug: serverSlug,
        spaceType: 'server_wiki',
        rootNamespaceCode: 'server',
        rootPath: `/server/${serverSlug}`,
        status: 'active',
        createdBy: profile.id,
        ownerUserId: profile.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await prisma.serverWiki.create({
      data: {
        spaceId: space.id,
        serverName: `Server ${unique}`,
        slug: serverSlug,
        edition: 'java',
        status: 'active',
        createdBy: profile.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    let pageId: string | undefined;
    try {
      const created = await edits.createPage(session(account.id), {
        namespace: 'server',
        title: `${serverSlug}/운영_규칙`,
        contentRaw: '== 운영 규칙 ==\n실제 규칙',
        editSummary: '하위 문서 생성',
      });
      pageId = created.pageId;
      const page = await prisma.wikiPage.findUnique({ where: { id: BigInt(created.pageId) } });
      assert.equal(page?.spaceId, space.id);
      assert.equal(page?.localPath, `${serverSlug}/운영_규칙`);
      assert.equal(page?.displayTitle, '운영_규칙');
      assert.equal(page?.pageType, 'server');
    } finally {
      if (pageId) {
        await prisma.wikiRecentChange.deleteMany({ where: { pageId: BigInt(pageId) } });
        await prisma.wikiPageRevision.deleteMany({ where: { pageId: BigInt(pageId) } });
        await prisma.wikiPage.delete({ where: { id: BigInt(pageId) } }).catch(() => {});
      }
      await prisma.serverWiki.deleteMany({ where: { spaceId: space.id } });
      await prisma.wikiSpace.delete({ where: { id: space.id } }).catch(() => {});
      await prisma.wikiProfile.deleteMany({ where: { accountId: account.id } });
      await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
    }
  });

  test('editing creates an ordered child revision and updates current page content', async () => {
    const fixture = await createFixture();
    let pageId: string | undefined;
    try {
      const created = await edits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code,
        title: `수정 ${fixture.unique}`,
        spaceId: fixture.space.id.toString(),
        contentRaw: '첫 내용',
        editSummary: '생성'
      });
      pageId = created.pageId;
      const edited = await edits.updatePage(session(fixture.account.id), created.pageId, {
        contentRaw: '첫 내용\n두 번째 줄',
        editSummary: '내용 보강',
        isMinor: true,
        baseRevisionId: created.revisionId
      });

      assert.equal(edited.revisionNo, 2);
      const revision = await edits.getRevision(edited.revisionId);
      assert.equal(revision.parentRevisionId, created.revisionId);
      assert.equal(revision.isMinor, true);
      assert.equal(revision.editSummary, '내용 보강');

      const history = await reads.getRevisions(created.pageId);
      assert.deepEqual(
        history.items.map((item) => item.revisionNo),
        [2, 1]
      );
      const diff = await edits.getRevisionDiff(created.revisionId, edited.revisionId);
      assert.ok(diff.hunks.some((hunk) => hunk.type === 'added' && hunk.line === '두 번째 줄'));
    } finally {
      await cleanupFixture({
        accountId: fixture.account.id,
        namespaceId: fixture.namespace.id,
        namespaceCode: fixture.namespace.code,
        spaceId: fixture.space.id,
        pageId
      });
    }
  });

  test('moving a document tree preserves children and creates redirects for every old path', async () => {
    const fixture = await createFixture();
    try {
      const rootTitle = `가이드_${fixture.unique}`;
      const childTitle = `${rootTitle}/설치`;
      const grandchildTitle = `${childTitle}/리눅스`;
      const root = await edits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code, title: rootTitle, spaceId: fixture.space.id.toString(), contentRaw: '가이드'
      });
      await edits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code, title: childTitle, spaceId: fixture.space.id.toString(), contentRaw: '설치'
      });
      await edits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code, title: grandchildTitle, spaceId: fixture.space.id.toString(), contentRaw: '리눅스'
      });
      const nextRoot = `매뉴얼_${fixture.unique}`;
      await edits.movePage(session(fixture.account.id), root.pageId, { title: nextRoot, leaveRedirect: true });

      const pages = await prisma.wikiPage.findMany({ where: { namespaceId: fixture.namespace.id } });
      const bySlug = new Map(pages.map((item) => [item.slug, item]));
      assert.equal(bySlug.get(nextRoot)?.pageType, 'article');
      assert.equal(bySlug.get(`${nextRoot}/설치`)?.pageType, 'article');
      assert.equal(bySlug.get(`${nextRoot}/설치/리눅스`)?.pageType, 'article');
      assert.equal(bySlug.get(rootTitle)?.pageType, 'redirect');
      assert.equal(bySlug.get(childTitle)?.pageType, 'redirect');
      assert.equal(bySlug.get(grandchildTitle)?.pageType, 'redirect');

      await assert.rejects(
        edits.deletePage(session(fixture.account.id), root.pageId, { reason: '트리 삭제 시도' }),
        /child documents cannot be deleted/
      );
    } finally {
      await cleanupFixture({
        accountId: fixture.account.id,
        namespaceId: fixture.namespace.id,
        namespaceCode: fixture.namespace.code,
        spaceId: fixture.space.id
      });
    }
  });

  test('accepting an edit request attributes the revision to its author and the review to its reviewer', async () => {
    const fixture = await createFixture();
    const reviewer = await prisma.account.create({
      data: { provider: 'email', providerUserId: `reviewer-${fixture.unique}`, email: `reviewer-${fixture.unique}@example.com`, displayName: `Reviewer_${fixture.unique}`, emailVerified: true }
    });
    let pageId: string | undefined;
    try {
      const created = await edits.createPage(session(fixture.account.id), { namespace: fixture.namespace.code, title: `제안 ${fixture.unique}`, spaceId: fixture.space.id.toString(), contentRaw: '기준 내용', editSummary: '생성' });
      pageId = created.pageId;
      const [authorProfile, reviewerProfile] = await Promise.all([profiles.ensureWikiProfile(fixture.account.id), profiles.ensureWikiProfile(reviewer.id)]);
      const pending = await prisma.wikiEditRequest.create({
        data: { pageId: BigInt(created.pageId), baseRevisionId: BigInt(created.revisionId), proposedContent: '기준 내용\n제안 추가', editSummary: '제안 반영', isMinor: false, status: 'pending', createdBy: authorProfile.id, createdAt: new Date(), updatedAt: new Date() }
      });

      const accepted = await edits.acceptEditRequest(session(reviewer.id, true), { requestId: pending.id, reviewNote: '검토 완료' });
      const revision = await prisma.wikiPageRevision.findUniqueOrThrow({ where: { id: BigInt(accepted.mutation.revisionId) } });
      const recent = await prisma.wikiRecentChange.findFirstOrThrow({ where: { revisionId: revision.id } });

      assert.equal(revision.createdBy, authorProfile.id);
      assert.equal(recent.actorId, authorProfile.id);
      assert.equal(accepted.request.reviewedBy, reviewerProfile.id);
      assert.equal(accepted.request.status, 'accepted');
    } finally {
      if (pageId) await prisma.wikiEditRequest.deleteMany({ where: { pageId: BigInt(pageId) } });
      await cleanupFixture({ accountId: fixture.account.id, namespaceId: fixture.namespace.id, namespaceCode: fixture.namespace.code, spaceId: fixture.space.id, pageId });
      await prisma.wikiProfile.deleteMany({ where: { accountId: reviewer.id } });
      await prisma.account.delete({ where: { id: reviewer.id } }).catch(() => {});
    }
  });

  test('edit request approval rolls back the document when completion delivery fails', async () => {
    const fixture = await createFixture();
    const reviewer = await prisma.account.create({
      data: { provider: 'email', providerUserId: `rollback-reviewer-${fixture.unique}`, email: `rollback-reviewer-${fixture.unique}@example.com`, displayName: `RollbackReviewer_${fixture.unique}`, emailVerified: true }
    });
    let pageId: string | undefined;
    try {
      const created = await edits.createPage(session(fixture.account.id), { namespace: fixture.namespace.code, title: `원자성 ${fixture.unique}`, spaceId: fixture.space.id.toString(), contentRaw: '원래 내용', editSummary: '생성' });
      pageId = created.pageId;
      const authorProfile = await profiles.ensureWikiProfile(fixture.account.id);
      await profiles.ensureWikiProfile(reviewer.id);
      const pending = await prisma.wikiEditRequest.create({
        data: { pageId: BigInt(created.pageId), baseRevisionId: BigInt(created.revisionId), proposedContent: '바뀐 내용', editSummary: '실패할 승인', isMinor: false, status: 'pending', createdBy: authorProfile.id, createdAt: new Date(), updatedAt: new Date() }
      });
      const failingNotifications = {
        async notifyWatchedRevision() {},
        async notifyEditRequestReviewed() { throw new Error('notification transaction failure'); }
      } as unknown as WikiNotificationService;
      const atomicEdits = new WikiEditService(prisma, profiles, permissions, undefined, undefined, failingNotifications);

      await assert.rejects(atomicEdits.acceptEditRequest(session(reviewer.id, true), { requestId: pending.id, reviewNote: null }), /notification transaction failure/);

      const [unchangedPage, unchangedRequest, revisionCount] = await Promise.all([
        prisma.wikiPage.findUniqueOrThrow({ where: { id: BigInt(created.pageId) } }),
        prisma.wikiEditRequest.findUniqueOrThrow({ where: { id: pending.id } }),
        prisma.wikiPageRevision.count({ where: { pageId: BigInt(created.pageId) } })
      ]);
      assert.equal(unchangedPage.currentRevisionId, BigInt(created.revisionId));
      assert.equal(unchangedRequest.status, 'pending');
      assert.equal(revisionCount, 1);
    } finally {
      if (pageId) await prisma.wikiEditRequest.deleteMany({ where: { pageId: BigInt(pageId) } });
      await cleanupFixture({ accountId: fixture.account.id, namespaceId: fixture.namespace.id, namespaceCode: fixture.namespace.code, spaceId: fixture.space.id, pageId });
      await prisma.wikiProfile.deleteMany({ where: { accountId: reviewer.id } });
      await prisma.account.delete({ where: { id: reviewer.id } }).catch(() => {});
    }
  });

  test('section locks preserve protected content while allowing unrelated edits', async () => {
    const fixture = await createFixture();
    let pageId: string | undefined;
    try {
      const created = await edits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code,
        title: `잠금 ${fixture.unique}`,
        spaceId: fixture.space.id.toString(),
        contentRaw: '== Intro ==\n보호된 내용\n\n== Notes ==\n메모',
        editSummary: '생성'
      });
      pageId = created.pageId;
      await prisma.pageSectionLock.create({
        data: {
          pageId: BigInt(created.pageId),
          anchor: 'Intro',
          heading: 'Intro',
          lockType: 'admin_only',
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });

      const unrelated = await edits.updatePage(session(fixture.account.id), created.pageId, {
        contentRaw: '== Intro ==\n보호된 내용\n\n== Notes ==\n수정된 메모',
        baseRevisionId: created.revisionId
      });
      assert.equal(unrelated.revisionNo, 2);

      await assert.rejects(
        edits.updatePage(session(fixture.account.id), created.pageId, {
          contentRaw: '== Intro ==\n보호된 내용\n\n== Intro ==\n우회 내용\n\n== Notes ==\n수정된 메모',
          baseRevisionId: unrelated.revisionId
        }),
        /Wiki section is locked: Intro|blocking errors/
      );

      await assert.rejects(
        edits.updatePage(session(fixture.account.id), created.pageId, {
          contentRaw: '== Intro ==\n변조된 내용\n\n== Notes ==\n수정된 메모',
          baseRevisionId: unrelated.revisionId
        }),
        /Wiki section is locked: Intro/
      );

      const elevated = await edits.updatePage(session(fixture.account.id, true), created.pageId, {
        contentRaw: '== Intro ==\n관리자 수정\n\n== Notes ==\n수정된 메모',
        baseRevisionId: unrelated.revisionId
      });
      assert.equal(elevated.revisionNo, 3);
    } finally {
      await cleanupFixture({
        accountId: fixture.account.id,
        namespaceId: fixture.namespace.id,
        namespaceCode: fixture.namespace.code,
        spaceId: fixture.space.id,
        pageId
      });
    }
  });
}
