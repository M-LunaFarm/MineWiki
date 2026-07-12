import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { WikiEditService } from './wiki-edit.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiReadService } from './wiki-read.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

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
        history.map((item) => item.revisionNo),
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
