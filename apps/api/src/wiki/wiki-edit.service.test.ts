import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { parseMarkup } from '@minewiki/wiki-core';
import {
  astContainsFile,
  categoryDocumentReferencesSelf,
  isUserDocumentRoot,
  isReservedWikiToolPath,
  replaceSectionByAnchor,
  sectionByAnchor,
  userDocumentTreeHasSingleOwner,
  WikiEditService,
  type WikiPageMutationRequest
} from './wiki-edit.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiReadService } from './wiki-read.service';
import type { WikiNotificationService } from './wiki-notification.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

function hasHttpErrorCode(error: unknown, code: string, status: number): boolean {
  if (!(error instanceof HttpException) || error.getStatus() !== status) return false;
  const response = error.getResponse();
  return typeof response === 'object' && response !== null && 'code' in response
    && response.code === code;
}

test('file dependencies are detected across block and inline containers', () => {
  assert.equal(astContainsFile(parseMarkup('일반 문서').ast), false);
  assert.equal(astContainsFile(parseMarkup('{{{#!folding 자세히\n[[파일:logo.png]]\n}}}').ast), true);
  assert.equal(astContainsFile(parseMarkup('문장 [[파일:inline.png|아이콘]]').ast), true);
  assert.equal(astContainsFile(parseMarkup(' * 목록 [[파일:list.png]]').ast), true);
  assert.equal(astContainsFile(parseMarkup('||셀 [[파일:table.png]]||').ast), true);
});

test('category documents cannot list themselves as a parent', () => {
  assert.equal(categoryDocumentReferencesSelf('category', '게임 플레이/몹', ['게임_플레이/몹']), true);
  assert.equal(categoryDocumentReferencesSelf('category', '게임 플레이/몹', ['게임 플레이']), false);
  assert.equal(categoryDocumentReferencesSelf('main', '게임 플레이/몹', ['게임 플레이/몹']), false);
});

test('explicit tool routes are reserved without rejecting similarly named documents', () => {
  for (const namespace of ['main', 'mod', 'guide', 'category', 'file']) {
    assert.equal(isReservedWikiToolPath(namespace, '_tools/edit/문서'), true);
    assert.equal(isReservedWikiToolPath(namespace, 'API/_tools/edit'), false);
    assert.equal(isReservedWikiToolPath(namespace, 'history'), false);
    assert.equal(isReservedWikiToolPath(namespace, 'API/edit'), false);
  }
  assert.equal(isReservedWikiToolPath('server', 'minewiki/_tools/edit/규칙'), true);
  assert.equal(isReservedWikiToolPath('server', 'minewiki/API/_tools'), false);
});

test('user root documents and cross-owner trees are rejected by immutable ownership invariants', () => {
  assert.equal(isUserDocumentRoot({ ownerProfileId: 10n, localPath: 'owner_name' }), true);
  assert.equal(isUserDocumentRoot({ ownerProfileId: 10n, localPath: 'owner_name/작업실' }), false);
  assert.equal(isUserDocumentRoot({ ownerProfileId: null, localPath: 'owner_name' }), false);

  assert.equal(userDocumentTreeHasSingleOwner(10n, 10n, [
    { ownerProfileId: 10n },
    { ownerProfileId: 10n }
  ]), true);
  assert.equal(userDocumentTreeHasSingleOwner(10n, 20n, [{ ownerProfileId: 10n }]), false);
  assert.equal(userDocumentTreeHasSingleOwner(10n, 10n, [
    { ownerProfileId: 10n },
    { ownerProfileId: 20n }
  ]), false);
  assert.equal(userDocumentTreeHasSingleOwner(null, null, []), false);
});

test('section ranges are derived from server-parsed heading anchors', () => {
  const content = '서문\r\n== 소개 ==\r\n소개 본문\r\n=== 세부 ===\r\n세부 본문\r\n== 마무리 ==\r\n마지막';
  const section = sectionByAnchor(content, '소개');

  assert.deepEqual(section, {
    anchor: '소개',
    title: '소개',
    contentRaw: '== 소개 ==\n소개 본문',
    startLine: 2,
    endLine: 3
  });
  assert.equal(sectionByAnchor(content, '없음'), null);
});

test('section replacement preserves every adjacent line and supports the final section', () => {
  const content = '서문\n== 소개 ==\n이전\n== 마무리 ==\n마지막';
  const replaced = replaceSectionByAnchor(content, '소개', '== 소개 ==\n수정');
  const final = replaceSectionByAnchor(replaced ?? '', '마무리', '== 결론 ==\n완료');

  assert.equal(replaced, '서문\n== 소개 ==\n수정\n== 마무리 ==\n마지막');
  assert.equal(final, '서문\n== 소개 ==\n수정\n== 결론 ==\n완료');
});

function session(userId: string, isElevated = false, permissions: string[] = []) {
  return {
    sessionId: `test-session-${userId}`,
    userId,
    isElevated,
    permissions
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

test('revision diff rejects cross-page comparisons after authorizing both revisions', async () => {
  const revisions = new Map([
    [11n, {
      id: 11n, pageId: 7n, revisionNo: 1, parentRevisionId: null, contentRaw: '첫 문서',
      contentHash: 'a'.repeat(64), contentSize: 10, syntaxVersion: 'bwm-0.3', editSummary: null,
      isMinor: false, createdBy: 3n, actorUserId: 3n, createdAt: new Date(), visibility: 'public'
    }],
    [12n, {
      id: 12n, pageId: 8n, revisionNo: 1, parentRevisionId: null, contentRaw: '둘째 문서',
      contentHash: 'b'.repeat(64), contentSize: 11, syntaxVersion: 'bwm-0.3', editSummary: null,
      isMinor: false, createdBy: 4n, actorUserId: 4n, createdAt: new Date(), visibility: 'public'
    }]
  ]);
  const prisma = {
    wikiPageRevision: { async findUnique(input: { where: { id: bigint } }) { return revisions.get(input.where.id) ?? null; } },
    wikiPage: {
      async findUnique(input: { where: { id: bigint } }) {
        return { id: input.where.id, spaceId: 1n, title: `문서 ${input.where.id}`, protectionLevel: 'open', status: 'normal' };
      }
    }
  } as unknown as PrismaService;
  let authorizationChecks = 0;
  const permissions = {
    async assertCanReadPage() { authorizationChecks += 1; },
    async assertCanUsePageAction() { authorizationChecks += 1; }
  } as unknown as WikiPermissionService;
  const edits = new WikiEditService(prisma, {} as WikiProfileService, permissions);

  await assert.rejects(
    edits.getRevisionDiff('11', '12'),
    (error: unknown) => error instanceof BadRequestException
  );
  assert.equal(authorizationChecks, 4);
});

test('revision diff enforces an API token space before returning revision source', async () => {
  const revision = {
    id: 11n, pageId: 7n, revisionNo: 1, parentRevisionId: null, contentRaw: '문서',
    contentHash: 'a'.repeat(64), contentSize: 6, syntaxVersion: 'bwm-0.3', editSummary: null,
    isMinor: false, createdBy: 3n, actorUserId: 3n, createdAt: new Date(), visibility: 'public'
  };
  const prisma = {
    wikiPageRevision: { async findUnique() { return revision; } },
    wikiPage: { async findUnique() { return { id: 7n, spaceId: 9n, title: '문서', protectionLevel: 'open', status: 'normal' }; } }
  } as unknown as PrismaService;
  let permissionChecks = 0;
  const permissions = {
    async assertCanReadPage() { permissionChecks += 1; },
    async assertCanUsePageAction() { permissionChecks += 1; }
  } as unknown as WikiPermissionService;
  const edits = new WikiEditService(prisma, {} as WikiProfileService, permissions);

  await assert.rejects(
    edits.getRevisionDiff('11', '11', 'account', { allowedSpaceId: 10n }),
    NotFoundException
  );
  assert.equal(permissionChecks, 0);
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

test('API space constraints reject a create target resolved outside the token space', async () => {
  const prisma = {
    wikiNamespace: { async findUnique() { return { id: 1, code: 'main' }; } },
    wikiSpace: { async findUnique() { return { id: 9n, status: 'active', spaceType: 'basic', rootNamespaceCode: 'main' }; } },
  } as unknown as PrismaService;
  const edits = new WikiEditService(prisma, {} as WikiProfileService, {} as WikiPermissionService);

  await assert.rejects(
    edits.createPage(
      session('account'),
      { namespace: 'main', title: '문서', spaceId: '9', contentRaw: '내용' },
      { allowedSpaceId: 10n },
    ),
    /Wiki space not found/u,
  );
});

test('API space constraints reject raw and update access before ACL evaluation', async () => {
  let aclChecks = 0;
  const page = {
    id: 7n,
    namespaceId: 1,
    spaceId: 9n,
    status: 'normal',
    currentRevisionId: 11n,
  };
  const prisma = {
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    async $queryRaw() { return [{ id: 7n }]; },
    wikiPage: { async findUnique() { return page; } },
  } as unknown as PrismaService;
  const profiles = {
    async ensureWikiProfile() { return { id: 3n, status: 'active' }; },
  } as unknown as WikiProfileService;
  const permissions = {
    async assertCanReadPage() { aclChecks += 1; },
    async assertCanUsePageAction() { aclChecks += 1; },
    async assertCanEditPage() { aclChecks += 1; },
  } as unknown as WikiPermissionService;
  const edits = new WikiEditService(prisma, profiles, permissions);

  await assert.rejects(
    edits.getRawPage('7', 'account', null, { allowedSpaceId: 10n }),
    /Wiki page not found/u,
  );
  await assert.rejects(
    edits.updatePage(
      session('account'),
      '7',
      { baseRevisionId: '11', contentRaw: '수정' },
      { allowedSpaceId: 10n },
    ),
    /Wiki page not found/u,
  );
  assert.equal(aclChecks, 0);
});

test('new-page request acceptance creates the page and first revision atomically under the requester identity', async () => {
  const now = new Date('2026-07-15T00:00:00Z');
  const request = {
    id: 71n, requestKind: 'create', pageId: null, baseRevisionId: null,
    targetNamespaceId: 2, targetNamespaceCode: 'guide', targetSpaceId: 9n,
    targetTitle: '새 문서', targetSlug: '새_문서', targetDisplayTitle: '새 문서', targetPageType: 'article',
    proposedContent: '== 소개 ==\n새 문서', editSummary: '새 문서 제안', isMinor: false,
    status: 'pending', createdBy: 13n, reviewedBy: null, reviewNote: null, acceptedRevisionId: null,
    createdAt: now, updatedAt: now, reviewedAt: null
  };
  let namespaceLocks = 0;
  let pageCreatedBy: bigint | null = null;
  let revisionCreatedBy: bigint | null = null;
  let recentActor: bigint | null = null;
  const stored = { ...request };
  const prisma = {
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    async $queryRaw() { namespaceLocks += 1; return [{ id: 2 }]; },
    wikiEditRequest: {
      async findUnique() { return { ...stored }; },
      async findUniqueOrThrow() { return { ...stored }; },
      async updateMany(args: { where: { status: string }; data: Record<string, unknown> }) {
        if (stored.status !== args.where.status) return { count: 0 };
        Object.assign(stored, args.data);
        return { count: 1 };
      }
    },
    wikiNamespace: { async findUnique() { return { id: 2, code: 'guide' }; } },
    wikiSpace: { async findUnique() { return { id: 9n, status: 'active' }; } },
    wikiPage: {
      async findUnique() { return null; },
      async create(args: { data: { createdBy: bigint } }) {
        pageCreatedBy = args.data.createdBy;
        return { id: 80n, namespaceId: 2, spaceId: 9n, localPath: '새_문서', slug: '새_문서', title: '새 문서', displayTitle: '새 문서', currentRevisionId: null };
      },
      async update() { return {}; }
    },
    wikiPageRevision: {
      async create(args: { data: { createdBy: bigint } }) {
        revisionCreatedBy = args.data.createdBy;
        return { id: 81n, pageId: 80n, revisionNo: 1, contentSize: 25, editSummary: '새 문서 제안', isMinor: false };
      }
    },
    wikiPageRenderCache: { async create() { return {}; } },
    wikiRecentChange: {
      async create(args: { data: { actorId: bigint } }) { recentActor = args.data.actorId; return {}; }
    }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 20n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: 'reviewer', profileId: 20n, status: 'active' }; },
    async canManageCreateTarget() { return true; }
  } as unknown as WikiPermissionService;
  const service = new WikiEditService(prisma, profiles, permissions);

  const accepted = await service.acceptCreateEditRequest(session('reviewer'), { requestId: 71n, reviewNote: '승인' });

  assert.equal(namespaceLocks, 1);
  assert.equal(pageCreatedBy, 13n);
  assert.equal(revisionCreatedBy, 13n);
  assert.equal(recentActor, 13n);
  assert.equal(accepted.mutation.pageId, '80');
  assert.equal(accepted.request.status, 'accepted');
  assert.equal(accepted.request.reviewedBy, 20n);
  assert.equal(accepted.request.pageId, 80n);
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

test('section edit checks read, raw, and edit ACL before returning source', async () => {
  const actions: string[] = [];
  const page = {
    id: 7n, spaceId: 1n, namespaceId: 1, title: '문서', status: 'normal',
    protectionLevel: 'open', currentRevisionId: 11n
  };
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiPageRevision: {
      async findFirst() { return { id: 11n, pageId: 7n, contentRaw: '== 소개 ==\n본문', visibility: 'public' }; }
    }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 3n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    async assertCanReadPage() { actions.push('read'); },
    async assertCanUsePageAction(input: { action: string }) { actions.push(input.action); },
    async assertCanEditPage() { actions.push('edit'); },
    actorFromSession() { return { accountId: 'account', profileId: 3n, status: 'active' }; }
  } as unknown as WikiPermissionService;
  const service = new WikiEditService(prisma, profiles, permissions);

  const section = await service.getSectionForEdit(session('account'), '7', '소개');

  assert.equal(section.contentRaw, '== 소개 ==\n본문');
  assert.equal(section.baseRevisionId, '11');
  assert.deepEqual(actions, ['read', 'raw', 'edit']);
});

test('section edit rebuilds the full document and delegates final validation to updatePage', async () => {
  const page = {
    id: 7n, spaceId: 1n, namespaceId: 1, title: '문서', status: 'normal',
    protectionLevel: 'open', currentRevisionId: 11n
  };
  const revision = { id: 11n, pageId: 7n, contentRaw: '서문\n== 소개 ==\n이전\n== 다음 ==\n보존', visibility: 'public' };
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiPageRevision: {
      async findFirst() { return revision; },
      async findUnique() { return revision; }
    }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 3n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    async assertCanReadPage() {}, async assertCanUsePageAction() {}, async assertCanEditPage() {},
    actorFromSession() { return { accountId: 'account', profileId: 3n, status: 'active' }; }
  } as unknown as WikiPermissionService;
  const service = new WikiEditService(prisma, profiles, permissions);
  let delegated: WikiPageMutationRequest | null = null;
  service.updatePage = async (_session, _pageId, request) => {
    delegated = request;
    return { pageId: '7', revisionId: '12', revisionNo: 2, namespace: 'main', title: '문서', slug: '문서' };
  };

  const result = await service.updateSection(session('account'), '7', '소개', {
    contentRaw: '== 새 소개 ==\n수정',
    editSummary: '섹션 수정',
    baseRevisionId: '11'
  });

  assert.equal(result.sectionAnchor, '새-소개');
  assert.equal(delegated?.contentRaw, '서문\n== 새 소개 ==\n수정\n== 다음 ==\n보존');
  assert.equal(delegated?.baseRevisionId, '11');
  assert.equal(delegated?.editSummary, '섹션 수정');
});

test('section edit rejects foreign bases and replacement without a heading', async () => {
  const page = { id: 7n, spaceId: 1n, namespaceId: 1, title: '문서', status: 'normal', protectionLevel: 'open', currentRevisionId: 11n };
  const revision = { id: 11n, pageId: 7n, contentRaw: '== 소개 ==\n본문', visibility: 'public' };
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiPageRevision: {
      async findFirst() { return revision; },
      async findUnique(input: { where: { id: bigint } }) { return input.where.id === revision.id ? revision : null; }
    }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 3n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    async assertCanReadPage() {}, async assertCanUsePageAction() {}, async assertCanEditPage() {},
    actorFromSession() { return { accountId: 'account', profileId: 3n, status: 'active' }; }
  } as unknown as WikiPermissionService;
  const service = new WikiEditService(prisma, profiles, permissions);

  await assert.rejects(
    service.updateSection(session('account'), '7', '소개', { contentRaw: '== 소개 ==\n수정', baseRevisionId: '10' }),
    /Base revision does not match this document/
  );
  await assert.rejects(
    service.updateSection(session('account'), '7', '소개', { contentRaw: '제목 없음', baseRevisionId: '11' }),
    /must begin with a wiki heading/
  );
});

test('file document creation rechecks edit and upload_file permissions', async () => {
  const actions: string[] = [];
  const prisma = {
    wikiPage: { async findUnique() { return { id: 7n, spaceId: 1n, title: '문서', protectionLevel: 'open', status: 'normal' }; } },
    wikiNamespace: { async findUnique() { return null; } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 3n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: 'account', profileId: 3n, status: 'active' }; },
    async assertCanEditPage() { actions.push('edit'); },
    async assertCanUsePageAction(input: { action: string }) { actions.push(input.action); }
  } as unknown as WikiPermissionService;
  const service = new WikiEditService(prisma, profiles, permissions);

  await assert.rejects(
    service.createFileDocumentAfterAuthorizedUpload(session('account'), {
      filename: '12345678-1234-1234-1234-123456789abc.webp',
      linkedPageId: '7'
    }),
    /namespace not found/i
  );
  assert.deepEqual(actions, ['edit', 'upload_file']);
  await assert.rejects(
    service.createFileDocumentAfterAuthorizedUpload(session('account'), {
      filename: '../escape.webp',
      linkedPageId: '7'
    }),
    /filename is invalid/
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

  test('new edits advance beyond hidden revision numbers without changing the public parent', async () => {
    const fixture = await createFixture();
    let pageId: string | undefined;
    try {
      const created = await edits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code,
        title: `숨김 판 번호 ${fixture.unique}`,
        spaceId: fixture.space.id.toString(),
        contentRaw: '공개 기준판',
        editSummary: '기준판 생성'
      });
      pageId = created.pageId;
      const profile = await prisma.wikiProfile.findUniqueOrThrow({ where: { accountId: fixture.account.id } });
      await prisma.wikiPageRevision.create({
        data: {
          pageId: BigInt(created.pageId), revisionNo: 2, parentRevisionId: BigInt(created.revisionId),
          contentRaw: '숨겨진 판', contentAst: null, contentHash: 'a'.repeat(64), contentSize: 13,
          syntaxVersion: 'bwm-0.3', editSummary: '숨김', isMinor: false, editTags: null,
          createdBy: profile.id, actorType: 'user', actorUserId: profile.id,
          actorIp: null, actorIpText: null, actorIpHash: null, createdAt: new Date(), visibility: 'hidden'
        }
      });

      const updated = await edits.updatePage(session(fixture.account.id), created.pageId, {
        contentRaw: '새 공개판',
        editSummary: '숨김 판 이후 수정',
        baseRevisionId: created.revisionId
      });
      const revision = await prisma.wikiPageRevision.findUniqueOrThrow({ where: { id: BigInt(updated.revisionId) } });

      assert.equal(updated.revisionNo, 3);
      assert.equal(revision.parentRevisionId, BigInt(created.revisionId));
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

  test('edits one heading section without changing adjacent document content', async () => {
    const fixture = await createFixture();
    let pageId: string | undefined;
    try {
      const created = await edits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code,
        title: `섹션 편집 ${fixture.unique}`,
        spaceId: fixture.space.id.toString(),
        contentRaw: '서문\n== 소개 ==\n이전 본문\n== 보존 ==\n건드리지 않음',
        editSummary: '섹션 테스트 생성'
      });
      pageId = created.pageId;
      const section = await edits.getSectionForEdit(session(fixture.account.id), created.pageId, '소개');
      assert.equal(section.contentRaw, '== 소개 ==\n이전 본문');

      const updated = await edits.updateSection(session(fixture.account.id), created.pageId, '소개', {
        contentRaw: '== 소개 ==\n새 본문',
        editSummary: '소개 섹션만 수정',
        baseRevisionId: section.baseRevisionId
      });
      assert.equal(updated.sectionAnchor, '소개');
      const revision = await edits.getRevision(updated.revisionId, fixture.account.id);
      assert.equal(revision.contentRaw, '서문\n== 소개 ==\n새 본문\n== 보존 ==\n건드리지 않음');
      assert.equal(revision.editSummary, '소개 섹션만 수정');

      const independent = await edits.updateSection(session(fixture.account.id), created.pageId, '보존', {
        contentRaw: '== 보존 ==\n다른 사용자가 수정',
        editSummary: '다른 섹션 수정',
        baseRevisionId: section.baseRevisionId
      });
      assert.equal(independent.autoMerged, true);
      const independentRevision = await edits.getRevision(independent.revisionId, fixture.account.id);
      assert.match(independentRevision.contentRaw, /새 본문/);
      assert.match(independentRevision.contentRaw, /다른 사용자가 수정/);

      await assert.rejects(
        edits.updateSection(session(fixture.account.id), created.pageId, '소개', {
          contentRaw: '== 소개 ==\n지연된 수정',
          baseRevisionId: section.baseRevisionId
        }),
        /overlapping edits/
      );
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

  test('auto-merges independent stale edits and preserves merge provenance', async () => {
    const fixture = await createFixture();
    let pageId: string | undefined;
    try {
      const created = await edits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code,
        title: `3-way merge ${fixture.unique}`,
        spaceId: fixture.space.id.toString(),
        contentRaw: '== 소개 ==\n기준 소개\n\n== 접속 ==\nold.example.kr\n',
        editSummary: '병합 기준 생성'
      });
      pageId = created.pageId;

      const current = await edits.updatePage(session(fixture.account.id), created.pageId, {
        contentRaw: '== 소개 ==\n기준 소개\n\n== 접속 ==\nplay.example.kr\n',
        editSummary: '접속 주소 수정',
        baseRevisionId: created.revisionId
      });
      const merged = await edits.updatePage(session(fixture.account.id), created.pageId, {
        contentRaw: '== 소개 ==\n내가 고친 소개\n\n== 접속 ==\nold.example.kr\n',
        editSummary: '소개 수정',
        baseRevisionId: created.revisionId
      });

      assert.equal(merged.autoMerged, true);
      const mergedRevision = await prisma.wikiPageRevision.findUnique({
        where: { id: BigInt(merged.revisionId) }
      });
      assert.equal(mergedRevision?.parentRevisionId, BigInt(current.revisionId));
      assert.match(mergedRevision?.contentRaw ?? '', /내가 고친 소개/);
      assert.match(mergedRevision?.contentRaw ?? '', /play\.example\.kr/);
      assert.deepEqual(mergedRevision?.editTags, {
        autoMerged: true,
        baseRevisionId: created.revisionId,
        currentRevisionId: current.revisionId
      });
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

  test('overlapping stale edits return recoverable conflict content without writing a revision', async () => {
    const fixture = await createFixture();
    let pageId: string | undefined;
    try {
      const created = await edits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code,
        title: `merge conflict ${fixture.unique}`,
        spaceId: fixture.space.id.toString(),
        contentRaw: '기준 문장',
        editSummary: '충돌 기준 생성'
      });
      pageId = created.pageId;
      await edits.updatePage(session(fixture.account.id), created.pageId, {
        contentRaw: '최신 문장',
        editSummary: '최신 수정',
        baseRevisionId: created.revisionId
      });
      const before = await prisma.wikiPageRevision.count({ where: { pageId: BigInt(created.pageId) } });

      await assert.rejects(
        edits.updatePage(session(fixture.account.id), created.pageId, {
          contentRaw: '내 문장',
          editSummary: '내 수정',
          baseRevisionId: created.revisionId
        }),
        (error: unknown) => {
          const response = error instanceof Error && 'getResponse' in error
            ? (error as { getResponse(): unknown }).getResponse()
            : null;
          assert.equal(typeof response, 'object');
          const payload = response as { code?: string; details?: { conflictCount?: number; mergedContentRaw?: string } };
          assert.equal(payload.code, 'wiki_edit_conflict');
          assert.equal(payload.details?.conflictCount, 1);
          assert.match(payload.details?.mergedContentRaw ?? '', /^<<<<<<< 내 편집$/m);
          return true;
        }
      );
      const after = await prisma.wikiPageRevision.count({ where: { pageId: BigInt(created.pageId) } });
      assert.equal(after, before);
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

  test('creates a file namespace document after an authorized upload', async () => {
    const fixture = await createFixture();
    let sourcePageId: string | undefined;
    let filePageId: string | undefined;
    try {
      const source = await edits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code,
        title: `파일 출처 ${fixture.unique}`,
        spaceId: fixture.space.id.toString(),
        contentRaw: '파일 업로드 대상 문서'
      });
      sourcePageId = source.pageId;
      const filename = `${randomUUID()}.webp`;
      const fileDocument = await edits.createFileDocumentAfterAuthorizedUpload(session(fixture.account.id), {
        filename,
        linkedPageId: source.pageId
      });
      filePageId = fileDocument.pageId;
      assert.equal(fileDocument.namespace, 'file');
      assert.equal(fileDocument.title, filename);
      const revision = await edits.getRevision(fileDocument.revisionId, fixture.account.id);
      assert.match(revision.contentRaw, new RegExp(`\\[\\[파일:${filename.replace('.', '\\.')}`));
      assert.match(revision.contentRaw, /\[\[분류:파일\]\]/);
    } finally {
      if (filePageId) {
        const id = BigInt(filePageId);
        await prisma.wikiRecentChange.deleteMany({ where: { pageId: id } });
        await prisma.wikiPageRenderCache.deleteMany({ where: { pageId: id } });
        await prisma.wikiPageRevision.deleteMany({ where: { pageId: id } });
        await prisma.wikiPage.delete({ where: { id } }).catch(() => {});
      }
      await cleanupFixture({
        accountId: fixture.account.id,
        namespaceId: fixture.namespace.id,
        namespaceCode: fixture.namespace.code,
        spaceId: fixture.space.id,
        pageId: sourcePageId
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
        contributionPolicySource: '기여 정책에 동의해 주세요.',
        requireContributionPolicyAck: true,
        contributionPolicyVersion: 3,
        createdBy: profile.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    let pageId: string | undefined;
    try {
      await assert.rejects(
        () => edits.createPage(session(account.id), {
          namespace: 'server',
          title: `${serverSlug}/운영_규칙`,
          contentRaw: '== 운영 규칙 ==\n실제 규칙',
          editSummary: '하위 문서 생성',
        }),
        (error: unknown) => hasHttpErrorCode(error, 'WIKI_CONTRIBUTION_POLICY_ACCEPTANCE_REQUIRED', 422),
      );
      const created = await edits.createPage(session(account.id), {
        namespace: 'server',
        title: `${serverSlug}/운영_규칙`,
        contentRaw: '== 운영 규칙 ==\n실제 규칙',
        editSummary: '하위 문서 생성',
        policyAcceptance: { accepted: true, version: 3 },
      });
      pageId = created.pageId;
      const page = await prisma.wikiPage.findUnique({ where: { id: BigInt(created.pageId) } });
      assert.equal(page?.spaceId, space.id);
      assert.equal(page?.localPath, `${serverSlug}/운영_규칙`);
      assert.equal(page?.displayTitle, '운영_규칙');
      assert.equal(page?.pageType, 'server');

      await assert.rejects(
        () => edits.updatePage(session(account.id), created.pageId, {
          contentRaw: '== 운영 규칙 ==\n변경 규칙',
          editSummary: '정책 없는 수정',
          baseRevisionId: created.revisionId,
        }),
        (error: unknown) => hasHttpErrorCode(error, 'WIKI_CONTRIBUTION_POLICY_ACCEPTANCE_REQUIRED', 422),
      );
      const updated = await edits.updatePage(session(account.id), created.pageId, {
        contentRaw: '== 운영 규칙 ==\n변경 규칙',
        editSummary: '정책 동의 후 수정',
        baseRevisionId: created.revisionId,
        policyAcceptance: { accepted: true, version: 3 },
      });
      assert.equal(updated.revisionNo, 2);
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

      const accepted = await edits.acceptEditRequest(
        session(reviewer.id, false, ['wiki.admin']),
        { requestId: pending.id, reviewNote: '검토 완료' }
      );
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

      await assert.rejects(
        atomicEdits.acceptEditRequest(
          session(reviewer.id, false, ['wiki.admin']),
          { requestId: pending.id, reviewNote: null }
        ),
        /notification transaction failure/
      );

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

      const administrative = await edits.updatePage(session(fixture.account.id, false, ['wiki.admin']), created.pageId, {
        contentRaw: '== Intro ==\n관리자 수정\n\n== Notes ==\n수정된 메모',
        baseRevisionId: unrelated.revisionId
      });
      assert.equal(administrative.revisionNo, 3);
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
