import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { buildWikiSearchVector, parseMarkup } from '@minewiki/wiki-core';
import {
  astContainsFile,
  astContainsInclude,
  categoryDocumentReferencesSelf,
  isUserDocumentRoot,
  isReservedWikiToolPath,
  replaceSectionByAnchor,
  sectionByAnchor,
  userDocumentTreeHasSingleOwner,
  wikiMoveNamespaceInvariantViolation,
  WikiEditService,
  type WikiPageMutationRequest
} from './wiki-edit.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiAclService } from './wiki-acl.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiReadService } from './wiki-read.service';
import type { WikiNotificationService } from './wiki-notification.service';
import { WikiLinkIndexService } from './wiki-link-index.service';
import type { BusinessEventService } from '../events/business-event.service';
import type { WikiIncludeService } from './wiki-include.service';

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
  assert.equal(astContainsFile(parseMarkup('>> [[파일:quote.png]]').ast), true);
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

test('user, file, and server move invariants preserve identity and wiki boundaries', () => {
  assert.match(wikiMoveNamespaceInvariantViolation({
    previousNamespace: 'user', namespace: 'main', previousTitle: 'owner/page', title: 'page'
  }) ?? '', /cannot move across namespaces/);
  assert.match(wikiMoveNamespaceInvariantViolation({
    previousNamespace: 'main', namespace: 'file', previousTitle: 'page', title: 'asset.png'
  }) ?? '', /cannot move across namespaces/);
  assert.match(wikiMoveNamespaceInvariantViolation({
    previousNamespace: 'file', namespace: 'file', previousTitle: 'asset.png', title: 'renamed.webp'
  }) ?? '', /preserve the file extension/);
  assert.equal(wikiMoveNamespaceInvariantViolation({
    previousNamespace: 'file', namespace: 'file', previousTitle: 'asset.PNG', title: 'renamed.png'
  }), null);
  assert.match(wikiMoveNamespaceInvariantViolation({
    previousNamespace: 'server', namespace: 'guide', previousTitle: 'server/page', title: 'page'
  }) ?? '', /linked server wiki/);
  assert.match(wikiMoveNamespaceInvariantViolation({
    previousNamespace: 'server', namespace: 'server', previousTitle: 'server/page', title: 'server/renamed',
    previousSpaceId: 10n, spaceId: 20n
  }) ?? '', /linked server wiki/);
  assert.equal(wikiMoveNamespaceInvariantViolation({
    previousNamespace: 'server', namespace: 'server', previousTitle: 'server/page', title: 'server/renamed',
    previousSpaceId: 10n, spaceId: 10n
  }), null);
});

test('new document context resolves its space and exposes distinct create and request decisions', async () => {
  const permissionInputs: Array<Record<string, unknown>> = [];
  const prisma = {
    wikiNamespace: { async findUnique() { return { id: 1, code: 'main' }; } },
    wikiSpace: {
      async findUnique() { return { id: 10n, status: 'active', spaceType: 'basic', rootNamespaceCode: 'main' }; },
    },
    serverWiki: {},
  } as unknown as PrismaService;
  const profiles = {
    async ensureWikiProfile() { return { id: 3n, accountId: 'account-1', status: 'active' }; },
  } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: 'account-1', profileId: 3n, status: 'active', groups: [], permissions: [], requestIp: '' }; },
    async assertCanReadCreateTarget(input: Record<string, unknown>) { permissionInputs.push({ kind: 'read', ...input }); },
    async canCreatePage(input: Record<string, unknown>) { permissionInputs.push({ kind: 'create', ...input }); return { allowed: false, reason: 'request review' }; },
    async assertCanUseCreateTargetAction(input: Record<string, unknown>) { permissionInputs.push({ kind: 'request', ...input }); },
  } as unknown as WikiPermissionService;
  const service = new WikiEditService(prisma, profiles, permissions);
  const session = { userId: 'account-1' } as SessionPayload;

  const result = await service.getCreateContext(session, { namespace: 'main', title: '새 문서', spaceId: '10' });

  assert.deepEqual(result, {
    namespace: 'main', namespaceId: 1, spaceId: '10', title: '새 문서', displayTitle: '새 문서',
    pageType: 'article', canCreate: false, canRequest: true,
  });
  assert.deepEqual(permissionInputs.map((input) => input.kind), ['read', 'create', 'request']);
  assert.equal(permissionInputs[2]?.action, 'edit_request');
});

test('file page restoration reactivates only a retained asset with the same logical filename', async () => {
  const updates: unknown[] = [];
  const service = new WikiEditService(
    {} as PrismaService,
    {} as WikiProfileService,
    {} as WikiPermissionService,
  ) as unknown as {
    transitionFilePageAsset(
      tx: unknown,
      page: { id: bigint; title: string },
      status: 'normal' | 'deleted',
      now: Date,
    ): Promise<void>;
  };
  const tx = {
    uploadedFile: {
      async findFirst() { return { id: 'file-1', status: 'retained', wikiFilename: 'logo.webp' }; },
      async update(input: unknown) { updates.push(input); },
    },
    async $queryRaw() { return []; },
  };

  await service.transitionFilePageAsset(tx, { id: 7n, title: 'logo.webp' }, 'normal', new Date());

  assert.deepEqual(updates, [{
    where: { id: 'file-1' },
    data: { status: 'active', deletedAt: null, retainedUntil: null },
  }]);
});

test('file page restoration fails closed after the retained object is unavailable', async () => {
  const service = new WikiEditService(
    {} as PrismaService,
    {} as WikiProfileService,
    {} as WikiPermissionService,
  ) as unknown as {
    transitionFilePageAsset(tx: unknown, page: { id: bigint; title: string }, status: 'normal', now: Date): Promise<void>;
  };
  const tx = {
    uploadedFile: { async findFirst() { return null; } },
    async $queryRaw() { return []; },
  };

  await assert.rejects(
    () => service.transitionFilePageAsset(tx, { id: 7n, title: 'lost.webp' }, 'normal', new Date()),
    /retained asset is unavailable/u,
  );
});

test('subtree move redirects clone page ACLs atomically and keep raw old paths restricted', async () => {
  const sourceRoot = {
    id: 7n, namespaceId: 1, spaceId: 10n, localPath: 'old', slug: 'old', title: 'Old',
    displayTitle: 'Old', currentRevisionId: 71n, pageType: 'article', protectionLevel: 'open',
    status: 'normal', createdBy: 3n, ownerProfileId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-01-01T00:00:00.000Z')
  };
  const sourceChild = {
    ...sourceRoot, id: 8n, localPath: 'old/child', slug: 'old/child', title: 'Old/Child',
    displayTitle: 'Child', currentRevisionId: 81n
  };
  const pages = new Map<bigint, Record<string, unknown>>([[sourceRoot.id, sourceRoot], [sourceChild.id, sourceChild]]);
  const revisions = new Map<bigint, Record<string, unknown>>([
    [71n, { id: 71n, pageId: 7n, revisionNo: 1, parentRevisionId: null, visibility: 'public', contentRaw: '[[도움말:Root]]', contentHash: 'a'.repeat(64), contentSize: 21, syntaxVersion: 'bwm-0.3', editSummary: null, isMinor: false, createdBy: 3n, actorUserId: 3n, actorIpText: null, createdAt: new Date('2026-01-01T00:00:00.000Z') }],
    [81n, { id: 81n, pageId: 8n, revisionNo: 1, parentRevisionId: null, visibility: 'public', contentRaw: '[[분류:Child]]', contentHash: 'b'.repeat(64), contentSize: 20, syntaxVersion: 'bwm-0.3', editSummary: null, isMinor: false, createdBy: 3n, actorUserId: 3n, actorIpText: null, createdAt: new Date('2026-01-01T00:00:00.000Z') }]
  ]);
  const sourceRuleCreatedAt = new Date('2026-01-02T00:00:00.000Z');
  const sourceRuleUpdatedAt = new Date('2026-01-03T00:00:00.000Z');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const sourceAclRules = [
    { id: 501n, targetType: 'page', targetId: 7n, action: 'read', effect: 'allow', subjectType: 'user', subjectValue: '3', sortOrder: 10, reason: 'source owner may read', expiresAt: null, createdBy: 3n, createdAt: sourceRuleCreatedAt, updatedAt: sourceRuleUpdatedAt },
    { id: 502n, targetType: 'page', targetId: 7n, action: 'read', effect: 'deny', subjectType: 'perm', subjectValue: 'any', sortOrder: 20, reason: 'hide moved target', expiresAt, createdBy: 3n, createdAt: sourceRuleCreatedAt, updatedAt: sourceRuleUpdatedAt },
    { id: 503n, targetType: 'page', targetId: 7n, action: 'raw', effect: 'deny', subjectType: 'perm', subjectValue: 'guest', sortOrder: 10, reason: 'hide raw redirect', expiresAt: null, createdBy: 3n, createdAt: sourceRuleCreatedAt, updatedAt: sourceRuleUpdatedAt },
    { id: 504n, targetType: 'page', targetId: 8n, action: 'read', effect: 'deny', subjectType: 'perm', subjectValue: 'guest', sortOrder: 10, reason: 'hide child redirect', expiresAt, createdBy: 3n, createdAt: sourceRuleCreatedAt, updatedAt: sourceRuleUpdatedAt }
  ];
  const aclRules = [...sourceAclRules];
  const updates: Array<{ readonly id: bigint; readonly data: Record<string, unknown> }> = [];
  const recent: Array<Record<string, unknown>> = [];
  const lifecycle: Array<Record<string, unknown>> = [];
  const indexed: Array<{ readonly pageId: bigint; readonly revisionId: bigint }> = [];
  const permissionChecks: Array<{ readonly type: string; readonly namespace?: string; readonly spaceId?: bigint }> = [];
  let auditMetadata: Record<string, unknown> | null = null;
  const namespaces = [
    { id: 1, code: 'main' },
    { id: 2, code: 'guide' }
  ];
  const spaces = [
    { id: 10n, status: 'active', spaceType: 'basic', rootNamespaceCode: 'main', rootPageId: null },
    { id: 20n, status: 'active', spaceType: 'basic', rootNamespaceCode: 'guide', rootPageId: null }
  ];
  let nextPageId = 101n;
  let nextRevisionId = 1001n;
  let nextAclRuleId = 2001n;
  let failAclClone = true;
  let inTransaction = false;
  const tx = {
    async $queryRaw() { return []; },
    wikiProfile: {
      async findUnique() { return { id: 3n, status: 'active' }; }
    },
    wikiNamespace: {
      async findUnique(input: { where: { id?: number; code?: string } }) {
        return namespaces.find((item) => item.id === input.where.id || item.code === input.where.code) ?? null;
      }
    },
    wikiSpace: {
      async findUnique(input: { where: { id: bigint } }) {
        return spaces.find((item) => item.id === input.where.id) ?? null;
      }
    },
    serverWiki: { async findFirst() { return null; } },
    wikiPage: {
      async findUnique(input: { where: { id?: bigint; namespaceId_slug?: { namespaceId: number; slug: string } } }) {
        if (input.where.id !== undefined) return pages.get(input.where.id) ?? null;
        const key = input.where.namespaceId_slug;
        return [...pages.values()].find((item) => item.namespaceId === key?.namespaceId && item.slug === key.slug) ?? null;
      },
      async findMany(input: { where: { status?: unknown } }) {
        return input.where.status ? [...pages.values()] : [];
      },
      async create(input: { data: Record<string, unknown> }) {
        const created = { id: nextPageId++, currentRevisionId: null, ...input.data };
        pages.set(created.id, created);
        return created;
      },
      async update(input: { where: { id: bigint }; data: Record<string, unknown> }) {
        updates.push({ id: input.where.id, data: input.data });
        const updated = { ...pages.get(input.where.id)!, ...input.data };
        pages.set(input.where.id, updated);
        return updated;
      }
    },
    wikiPageRevision: {
      async findUnique(input: { where: { id: bigint } }) { return revisions.get(input.where.id) ?? null; },
      async findFirst(input: { where: { pageId: bigint } }) {
        return [...revisions.values()].find((item) => item.pageId === input.where.pageId) ?? null;
      },
      async create(input: { data: Record<string, unknown> }) {
        const created = { id: nextRevisionId++, ...input.data };
        revisions.set(created.id, created);
        return created;
      }
    },
    wikiPageRenderCache: {
      async create(input: { data: Record<string, unknown> }) { return input.data; }
    },
    aclRule: {
      async findMany(input: { where?: Record<string, unknown> }) {
        const where = input.where ?? {};
        const targetIds = (where.targetId as { in?: bigint[] } | undefined)?.in;
        const targets = where.OR as Array<{ targetType: string; targetId: bigint | null }> | undefined;
        const actions = typeof where.action === 'string'
          ? [where.action]
          : (where.action as { in?: string[] } | undefined)?.in;
        return aclRules.filter((rule) =>
          (where.targetType === undefined || rule.targetType === where.targetType) &&
          (!actions || actions.includes(rule.action)) &&
          (!targetIds || targetIds.includes(rule.targetId)) &&
          (!targets || targets.some((target) => target.targetType === rule.targetType && target.targetId === rule.targetId))
        );
      },
      async create(input: { data: Omit<(typeof sourceAclRules)[number], 'id'> }) {
        assert.equal(inTransaction, true);
        if (failAclClone) throw new Error('acl clone failed');
        const created = { id: nextAclRuleId++, ...input.data };
        aclRules.push(created);
        return created;
      }
    },
    wikiRecentChange: {
      async create(input: { data: Record<string, unknown> }) { recent.push(input.data); return input.data; }
    },
    wikiPageLifecycleEvent: {
      async createMany(input: { data: Array<Record<string, unknown>> }) { lifecycle.push(...input.data); return { count: input.data.length }; }
    }
  };
  const prisma = {
    ...tx,
    async $transaction<T>(callback: (store: typeof tx) => Promise<T>) {
      const pageSnapshot = new Map([...pages].map(([id, page]) => [id, { ...page }]));
      const revisionSnapshot = new Map([...revisions].map(([id, revision]) => [id, { ...revision }]));
      const lengths = {
        aclRules: aclRules.length, updates: updates.length, recent: recent.length, lifecycle: lifecycle.length,
        indexed: indexed.length, permissionChecks: permissionChecks.length
      };
      const ids = { nextPageId, nextRevisionId, nextAclRuleId };
      inTransaction = true;
      try {
        return await callback(tx);
      } catch (error) {
        pages.clear();
        for (const [id, page] of pageSnapshot) pages.set(id, page);
        revisions.clear();
        for (const [id, revision] of revisionSnapshot) revisions.set(id, revision);
        aclRules.length = lengths.aclRules;
        updates.length = lengths.updates;
        recent.length = lengths.recent;
        lifecycle.length = lengths.lifecycle;
        indexed.length = lengths.indexed;
        permissionChecks.length = lengths.permissionChecks;
        ({ nextPageId, nextRevisionId, nextAclRuleId } = ids);
        throw error;
      } finally {
        inTransaction = false;
      }
    }
  } as unknown as PrismaService;
  const profiles = {
    async ensureWikiProfile() { return { id: 3n, status: 'active' }; }
  } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: 'account', profileId: 3n, status: 'active' }; },
    async assertCanMutatePageAction() { permissionChecks.push({ type: 'move' }); },
    async assertCanCreatePage(input: { namespaceCode: string; spaceId: bigint }) {
      permissionChecks.push({ type: 'create', namespace: input.namespaceCode, spaceId: input.spaceId });
    }
  } as unknown as WikiPermissionService;
  const events = {
    async audit(_action: string, event: { metadata: Record<string, unknown> }) { auditMetadata = event.metadata; }
  } as unknown as BusinessEventService;
  const links = {
    async replaceForRevision(_store: unknown, pageId: bigint, revisionId: bigint) {
      indexed.push({ pageId, revisionId });
    }
  } as unknown as WikiLinkIndexService;
  const edits = new WikiEditService(prisma, profiles, permissions, events, links);

  await assert.rejects(
    edits.movePage(session('account'), '7', {
      namespace: 'guide', spaceId: '20', title: 'New', leaveRedirect: true, reason: 'reorganize'
    }),
    /acl clone failed/
  );
  assert.equal(pages.get(7n)?.title, 'Old');
  assert.equal(pages.get(8n)?.title, 'Old/Child');
  assert.equal([...pages.values()].some((item) => item.pageType === 'redirect'), false);
  assert.equal(aclRules.length, sourceAclRules.length);
  assert.equal(recent.length, 0);
  assert.equal(lifecycle.length, 0);
  assert.equal(auditMetadata, null);

  failAclClone = false;
  const result = await edits.movePage(session('account'), '7', {
    namespace: 'guide', spaceId: '20', title: 'New', leaveRedirect: true, reason: 'reorganize'
  });

  assert.equal(result.namespace, 'guide');
  assert.equal(result.previousNamespace, 'main');
  assert.equal(result.previousSpaceId, '10');
  assert.equal(result.spaceId, '20');
  assert.equal(result.movedPageCount, 2);
  assert.deepEqual(indexed.filter((item) => item.pageId === 7n || item.pageId === 8n), [
    { pageId: 7n, revisionId: 71n }, { pageId: 8n, revisionId: 81n }
  ]);
  const sourceUpdates = updates.filter((update) => update.id === 7n || update.id === 8n);
  assert.equal(sourceUpdates.every((update) => update.data.namespaceId === 2 && update.data.spaceId === 20n), true);
  assert.equal(sourceUpdates.every((update) => update.data.pageType === 'article' && update.data.ownerProfileId === null), true);
  assert.equal(pages.get(7n)?.title, 'New');
  assert.equal(pages.get(8n)?.title, 'New/Child');
  assert.equal(pages.get(7n)?.currentRevisionId, 71n);
  assert.equal(pages.get(8n)?.currentRevisionId, 81n);
  assert.equal(permissionChecks.filter((check) => check.type === 'move').length, 2);
  assert.equal(permissionChecks.filter((check) => check.type === 'create').length, 2);
  assert.equal(recent.length, 2);
  assert.equal(lifecycle.length, 2);
  assert.deepEqual(lifecycle.map((event) => [event.pageId, event.eventType, event.sourceTitle, event.destinationTitle]), [
    [7n, 'move', 'Old', 'New'],
    [8n, 'move', 'Old/Child', 'New/Child']
  ]);
  assert.equal(recent.every((change) => String(change.summary).includes('[main@10 -> guide@20]')), true);
  const redirects = [...pages.values()].filter((page) => page.pageType === 'redirect');
  const rootRedirect = redirects.find((page) => page.localPath === 'old');
  const childRedirect = redirects.find((page) => page.localPath === 'old/child');
  assert.ok(rootRedirect);
  assert.ok(childRedirect);

  const orderedPolicy = (rule: (typeof aclRules)[number]) => ({
    action: rule.action,
    effect: rule.effect,
    subjectType: rule.subjectType,
    subjectValue: rule.subjectValue,
    sortOrder: rule.sortOrder,
    reason: rule.reason,
    expiresAt: rule.expiresAt?.toISOString() ?? null,
    createdBy: rule.createdBy
  });
  const sortRules = (rules: typeof aclRules) => [...rules].sort((left, right) =>
    left.action.localeCompare(right.action) || left.sortOrder - right.sortOrder || (left.id < right.id ? -1 : 1)
  );
  for (const [sourceId, redirect] of [[7n, rootRedirect], [8n, childRedirect]] as const) {
    const sourceRules = sortRules(sourceAclRules.filter((rule) => rule.targetId === sourceId));
    const clonedRules = sortRules(aclRules.filter((rule) => rule.targetId === redirect.id));
    assert.deepEqual(clonedRules.map(orderedPolicy), sourceRules.map(orderedPolicy));
    assert.equal(clonedRules.every((rule) => !sourceAclRules.some((source) => source.id === rule.id)), true);
    assert.equal(clonedRules.every((rule) => rule.createdAt.getTime() > sourceRuleUpdatedAt.getTime()), true);
    assert.equal(clonedRules.every((rule) => rule.createdAt.getTime() === rule.updatedAt.getTime()), true);
  }

  const aclPermissions = new WikiPermissionService(prisma, new WikiAclService(prisma));
  const aclReads = new WikiReadService(prisma, aclPermissions);
  const aclEdits = new WikiEditService(prisma, profiles, aclPermissions);
  await assert.rejects(
    aclReads.getPage('main', 'Old', undefined, { followRedirects: false }),
    /Wiki page not found/
  );
  await assert.rejects(
    aclReads.getPage('main', 'Old/Child', undefined, { followRedirects: false }),
    /Wiki page not found/
  );
  await assert.rejects(
    aclEdits.getRawPage(String(rootRedirect.id), undefined),
    /Wiki page not found/
  );
  const allowedRaw = await aclEdits.getRawPage(String(rootRedirect.id), session('account'));
  assert.equal(allowedRaw.contentRaw, '#넘겨주기 [[guide:New]]');
  assert.deepEqual(auditMetadata, {
    previousTitle: 'Old', title: 'New', previousNamespace: 'main', namespace: 'guide',
    previousSpaceId: '10', spaceId: '20', movedPageCount: 2, redirectPageId: String(rootRedirect.id), reason: 'reorganize'
  });
});

test('section ranges are derived from server-parsed heading anchors', () => {
  const content = '서문\r\n== 소개 ==\r\n소개 본문\r\n=== 세부 ===\r\n세부 본문\r\n== 마무리 ==\r\n마지막';
  const section = sectionByAnchor(content, 's-1');

  assert.deepEqual(section, {
    anchor: 's-1',
    title: '소개',
    contentRaw: '== 소개 ==\n소개 본문',
    startLine: 2,
    endLine: 3
  });
  assert.deepEqual(sectionByAnchor(content, '소개'), section);
  assert.equal(sectionByAnchor('== 소개 ==\n첫째\n== 소개 ==\n둘째', '소개'), null);
  assert.equal(sectionByAnchor(content, '없음'), null);
});

test('section replacement preserves every adjacent line and supports the final section', () => {
  const content = '서문\n== 소개 ==\n이전\n== 마무리 ==\n마지막';
  const replaced = replaceSectionByAnchor(content, 's-1', '== 소개 ==\n수정');
  const final = replaceSectionByAnchor(replaced ?? '', 's-2', '== 결론 ==\n완료');

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

test('preview returns blocking markup errors', async () => {
  const edits = new WikiEditService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);
  const preview = await edits.preview('<script>alert(1)</script>');

  assert.ok(preview.blockingErrors.length > 0);
  assert.ok(preview.blockingErrors.some((error) => error.includes('HTML')));
});

test('preview expands readable includes with the authenticated page context', async () => {
  const page = {
    id: 7n,
    namespaceId: 3,
    spaceId: 9n,
    localPath: '서버-문서/안내',
    slug: 'server-doc/guide',
    title: '안내',
    displayTitle: '안내',
    currentRevisionId: 11n,
    pageType: 'article',
    protectionLevel: 'open',
    status: 'normal',
    currentContentSize: 0,
    currentCategoryCount: 0,
    createdBy: null,
    ownerProfileId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 4n, status: 'active' }; } },
    wikiPage: { async findUnique() { return page; } },
    wikiNamespace: { async findUnique() { return { id: 3, code: 'server' }; } },
  } as unknown as PrismaService;
  let readPageId: bigint | null = null;
  const permissions = {
    actorFromSession() { return { accountId: 'account-1', profileId: 4n, status: 'active' }; },
    async assertCanReadPage(input: { page: { id: bigint } }) { readPageId = input.page.id; },
  } as unknown as WikiPermissionService;
  let includeInput: Parameters<WikiIncludeService['expand']>[0] | null = null;
  const includes = {
    async expand(input: Parameters<WikiIncludeService['expand']>[0]) {
      includeInput = input;
      return {
        ast: [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text: '확장된 안내' }] }],
        includedSourceBytes: 12,
      };
    },
  } as WikiIncludeService;
  const edits = new WikiEditService(
    prisma,
    {} as WikiProfileService,
    permissions,
    undefined,
    undefined,
    undefined,
    undefined,
    includes,
  );

  const preview = await edits.preview('[include(틀:안내)]', {
    pageId: '7',
    namespace: 'main',
    localPath: '조작된/경로',
  }, session('account-1'));

  assert.equal(readPageId, 7n);
  assert.equal(includeInput?.sourcePageId, 7n);
  assert.equal(includeInput?.sourceNamespace, 'server');
  assert.equal(includeInput?.sourceLocalPath, '서버-문서/안내');
  assert.match(preview.html, /확장된 안내/u);
});

test('include detection covers nested preview containers', () => {
  assert.equal(astContainsInclude(parseMarkup('문서').ast), false);
  assert.equal(astContainsInclude(parseMarkup('{{{#!folding 안내\n[include(틀:안내)]\n}}}').ast), true);
});

test('revision diff aligns unchanged lines after an insertion', () => {
  const edits = new WikiEditService({} as PrismaService, {} as WikiProfileService, {} as WikiPermissionService);
  const hunks = edits.diffText('alpha\nbeta\ngamma', 'intro\nalpha\nbeta\ngamma');

  assert.deepEqual(hunks, [
    { type: 'added', line: 'intro', leftLine: null, rightLine: 1 },
    { type: 'context', line: 'alpha', leftLine: 1, rightLine: 2 },
    { type: 'context', line: 'beta', leftLine: 2, rightLine: 3 },
    { type: 'context', line: 'gamma', leftLine: 3, rightLine: 4 }
  ]);
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
    editSummary: '숨겨진 원본 요약',
    editSummaryHidden: true,
    isMinor: false,
    createdBy: 3n,
    actorUserId: 3n,
    createdAt: new Date('2026-07-13T00:00:00Z'),
    visibility: 'public'
  };
  const prisma = {
    wikiPageRevision: { async findUnique() { return revision; } },
    wikiPage: { async findUnique() { return { id: 7n, spaceId: 1n, title: '문서', protectionLevel: 'open', status: 'normal', currentRevisionId: 11n }; } }
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadPage() {},
    async assertCanUsePageAction(input: { action: string }) { actions.push(input.action); }
  } as unknown as WikiPermissionService;
  const edits = new WikiEditService(prisma, {} as WikiProfileService, permissions);

  const source = await edits.getRevision('11');
  const raw = await edits.getRawPage('7', undefined, '11');
  const diff = await edits.getRevisionDiff('11', '11');

  assert.deepEqual(actions, ['raw', 'raw', 'history', 'history']);
  for (const response of [source, raw, diff.left, diff.right]) {
    assert.equal(response.editSummary, null);
    assert.equal(response.editSummaryHidden, true);
    assert.equal(response.contentRaw, '문서 내용');
    assert.equal(response.contentHash, 'a'.repeat(64));
  }
});

test('public server wiki raw and diff reads allow published history but reject unpublished drafts', async () => {
  const now = new Date('2026-07-19T00:00:00Z');
  const page = {
    id: 7n, namespaceId: 7, spaceId: 40n, localPath: 'luna/guide', title: 'luna/guide',
    protectionLevel: 'open', status: 'normal', currentRevisionId: 13n,
  };
  const revision = (id: bigint, revisionNo: number, contentRaw: string) => ({
    id, pageId: 7n, revisionNo, parentRevisionId: revisionNo > 1 ? id - 1n : null, contentRaw,
    contentHash: id.toString().padStart(64, '0'), contentSize: contentRaw.length, syntaxVersion: 'bwm-0.3',
    editSummary: null, editSummaryHidden: false, isMinor: false, createdBy: 3n, actorType: 'user', actorUserId: 3n,
    actorIp: null, actorIpText: null, actorIpHash: null, createdAt: now, visibility: 'public',
  });
  const revisions = new Map([
    [11n, revision(11n, 1, 'release one')],
    [12n, revision(12n, 2, 'release two')],
    [13n, revision(13n, 3, 'unpublished draft')],
  ]);
  const releaseItem = (releaseId: bigint, revisionId: bigint, localPath: string) => ({
    id: releaseId, releaseId, serverWikiId: 50n, spaceId: 40n, namespaceId: 7, pageId: 7n, revisionId,
    localPath, slug: localPath, title: localPath, displayTitle: localPath, pageType: 'article',
    protectionLevel: 'open', pageStatus: 'normal', createdBy: 3n, ownerProfileId: null,
    pageUpdatedAt: now, searchVector: '', createdAt: now,
  });
  const historical = releaseItem(70n, 11n, 'luna/old-guide');
  const current = releaseItem(71n, 12n, 'luna/guide');
  const prisma = {
    wikiPageRevision: { async findUnique(input: { where: { id: bigint } }) { return revisions.get(input.where.id) ?? null; } },
    wikiPage: { async findUnique() { return page; } },
  } as unknown as PrismaService;
  const authorizedPaths: string[] = [];
  const permissions = {
    async resolvePublishedRevisionScope() { return { currentItem: current, revisionItems: [current, historical] }; },
    async assertCanReadPage(input: { page: { title: string } }) { authorizedPaths.push(input.page.title); },
    async assertCanUsePageAction() {},
  } as unknown as WikiPermissionService;
  const edits = new WikiEditService(prisma, {} as WikiProfileService, permissions);

  assert.equal((await edits.getRawPage('7')).id, '12');
  assert.equal((await edits.getRevision('11')).contentRaw, 'release one');
  assert.deepEqual((await edits.getRevisionDiff('11', '12')).hunks.map((hunk) => hunk.type), ['removed', 'added']);
  await assert.rejects(() => edits.getRevision('13'), (error: unknown) => error instanceof NotFoundException);
  await assert.rejects(() => edits.getRevisionDiff('11', '13'), (error: unknown) => error instanceof NotFoundException);
  assert.equal(authorizedPaths.includes('luna/old-guide'), true);
  assert.equal(authorizedPaths.includes('luna/guide'), true);
  assert.equal(authorizedPaths.includes('unpublished draft'), false);
});

test('raw revision and diff reads preserve browser session ACL claims and request address', async () => {
  const revision = {
    id: 11n, pageId: 7n, revisionNo: 1, parentRevisionId: null, contentRaw: '문서 내용',
    contentHash: 'a'.repeat(64), contentSize: 13, syntaxVersion: 'bwm-0.3', editSummary: null,
    isMinor: false, createdBy: 3n, actorUserId: 3n, createdAt: new Date(), visibility: 'public'
  };
  const page = { id: 7n, spaceId: 1n, title: '문서', protectionLevel: 'open', status: 'normal', currentRevisionId: 11n };
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 9n, status: 'active' }; } },
    wikiPageRevision: { async findUnique() { return revision; } },
    wikiPage: { async findUnique() { return page; } }
  } as unknown as PrismaService;
  const readInputs: Array<Record<string, unknown>> = [];
  const actor = {
    accountId: 'account', profileId: 9n, status: 'active', isElevated: true,
    groups: ['admin'], permissions: ['wiki.read.private'], requestIp: '198.51.100.8'
  };
  const permissions = {
    actorFromSession() { return actor; },
    async assertCanReadPage(input: Record<string, unknown>) { readInputs.push(input); },
    async assertCanUsePageAction(input: Record<string, unknown>) {
      assert.equal(input.accountId, 'account');
      assert.equal(input.actor, actor);
      assert.equal(input.requestIp, '198.51.100.8');
    }
  } as unknown as WikiPermissionService;
  const edits = new WikiEditService(prisma, {} as WikiProfileService, permissions);
  const browserSession = {
    ...session('account', true, ['wiki.read.private']),
    tokenVersion: 2,
    authenticatedAt: '2026-07-16T00:00:00.000Z',
    groups: ['admin'],
    requestIp: '198.51.100.8'
  } satisfies SessionPayload;

  await edits.getRawPage('7', browserSession);
  await edits.getRevision('11', browserSession);
  await edits.getRevisionDiff('11', '11', browserSession);

  assert.equal(readInputs.length, 5);
  assert.equal(readInputs.every((input) => input.accountId === 'account'), true);
  assert.equal(readInputs.every((input) => input.actor === actor), true);
  assert.equal(readInputs.every((input) => input.requestIp === '198.51.100.8'), true);
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

test('revert requires history access before loading or materializing a source revision', async () => {
  let revisionReads = 0;
  const page = {
    id: 7n,
    namespaceId: 1,
    spaceId: 9n,
    title: '숨김 역사 문서',
    status: 'normal',
    currentRevisionId: 12n,
  };
  const prisma = {
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    async $queryRaw() { return [{ id: 7n }]; },
    wikiPage: { async findUnique() { return page; } },
    wikiNamespace: { async findUnique() { return { id: 1, code: 'main' }; } },
    wikiPageRevision: {
      async findUnique() { revisionReads += 1; return null; },
      async findFirst() { revisionReads += 1; return null; },
    },
  } as unknown as PrismaService;
  const profiles = {
    async ensureWikiProfile() { return { id: 3n, status: 'active' }; },
  } as unknown as WikiProfileService;
  const actions: string[] = [];
  const permissions = {
    actorFromSession() { return { accountId: 'account', profileId: 3n, status: 'active' }; },
    async assertCanMutatePageAction(input: { action: string }) { actions.push(input.action); },
    async assertCanUsePageAction(input: { action: string }) {
      actions.push(input.action);
      throw new NotFoundException('Wiki page not found.');
    },
  } as unknown as WikiPermissionService;
  const edits = new WikiEditService(prisma, profiles, permissions);

  await assert.rejects(
    edits.revertPage(session('account'), '7', {
      revisionId: '11',
      baseRevisionId: '12',
      reason: '숨겨진 역사 판 되돌리기',
    }),
    NotFoundException,
  );

  assert.deepEqual(actions, ['revert', 'history']);
  assert.equal(revisionReads, 0);
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
    async canReviewCreateTarget() { return true; }
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

test('anonymous request approval attribution creates an IP revision without exposing a raw address', async () => {
  let stored: Record<string, unknown> | null = null;
  const prisma = {
    wikiPageRevision: {
      async create(args: { data: Record<string, unknown> }) {
        stored = args.data;
        return { id: 91n, pageId: 7n, revisionNo: 2, contentSize: 5, editSummary: '익명 제안', isMinor: false };
      },
    },
    wikiPageRenderCache: { async create() { return {}; } },
  } as unknown as PrismaService;
  const service = new WikiEditService(
    prisma,
    {} as WikiProfileService,
    {} as WikiPermissionService,
  ) as unknown as {
    createRevision(tx: PrismaService, input: Record<string, unknown>): Promise<unknown>;
  };
  await service.createRevision(prisma, {
    pageId: 7n,
    revisionNo: 2,
    parentRevisionId: 90n,
    contentRaw: '제안 내용',
    editSummary: '익명 제안',
    isMinor: false,
    actorId: null,
    actorType: 'ip',
    actorIpHash: 'a'.repeat(64),
    title: '문서',
    namespaceCode: 'main',
    pageTitle: '문서',
    pageLocalPath: '문서',
    createdAt: new Date('2026-07-19T00:00:00Z'),
  });
  assert.equal(stored?.createdBy, null);
  assert.equal(stored?.actorType, 'ip');
  assert.equal(stored?.actorUserId, null);
  assert.equal(stored?.actorIpHash, 'a'.repeat(64));
  assert.equal(stored?.actorIp, null);
  assert.equal(stored?.actorIpText, null);
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

  const section = await service.getSectionForEdit(session('account'), '7', 's-1');

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

  const result = await service.updateSection(session('account'), '7', 's-1', {
    contentRaw: '== 새 소개 ==\n수정',
    editSummary: '섹션 수정',
    baseRevisionId: '11'
  });

  assert.equal(result.sectionAnchor, 's-1');
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
    service.updateSection(session('account'), '7', 's-1', { contentRaw: '== 소개 ==\n수정', baseRevisionId: '10' }),
    /Base revision does not match this document/
  );
  await assert.rejects(
    service.updateSection(session('account'), '7', 's-1', { contentRaw: '제목 없음', baseRevisionId: '11' }),
    /must begin with a wiki heading/
  );
});

test('file document creation rechecks edit and upload_file permissions', async () => {
  const actions: string[] = [];
  const prisma = {
    wikiPage: { async findUnique() { return { id: 7n, spaceId: 1n, title: '문서', protectionLevel: 'open', status: 'normal' }; } },
    wikiSpace: {
      async findUnique() {
        return {
          id: 3n,
          status: 'active',
          rootNamespaceCode: 'main',
          title: '메인 위키',
          createdBy: 3n,
        };
      },
    },
    wikiNamespace: {
      async findUnique(input: { where: { code: string } }) {
        return input.where.code === 'main' ? { id: 1, code: 'main' } : null;
      },
    }
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
  actions.length = 0;
  await assert.rejects(
    service.createFileDocumentAfterAuthorizedUpload(session('account'), {
      filename: '12345678-1234-1234-1234-123456789abc.webp',
      linkedSpaceId: '3'
    }),
    /namespace not found/i
  );
  assert.deepEqual(actions, ['edit', 'upload_file']);
  await assert.rejects(
    service.createFileDocumentAfterAuthorizedUpload(session('account'), {
      filename: '12345678-1234-1234-1234-123456789abc.webp',
      linkedPageId: '7',
      linkedSpaceId: '3'
    }),
    /Exactly one linked wiki page or space/u
  );
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
      await prisma.wikiPageLifecycleEvent.deleteMany({ where: { pageId: page.id } });
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

  test('delete and restore append lifecycle events without creating content revisions', async () => {
    const fixture = await createFixture();
    let pageId: string | undefined;
    try {
      const created = await edits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code,
        title: `lifecycle_${fixture.unique}`,
        spaceId: fixture.space.id.toString(),
        contentRaw: 'lifecycle content'
      });
      pageId = created.pageId;
      await edits.deletePage(session(fixture.account.id), created.pageId, { reason: 'obsolete' });
      await edits.restorePage(session(fixture.account.id), created.pageId, { reason: 'needed again' });

      const [events, revisionCount, publicHistory] = await Promise.all([
        prisma.wikiPageLifecycleEvent.findMany({ where: { pageId: BigInt(created.pageId) }, orderBy: { id: 'asc' } }),
        prisma.wikiPageRevision.count({ where: { pageId: BigInt(created.pageId) } }),
        reads.getPageLifecycleEvents(created.pageId)
      ]);
      assert.deepEqual(events.map((event) => event.eventType), ['delete', 'restore']);
      assert.deepEqual(events.map((event) => event.reason), ['obsolete', 'needed again']);
      assert.equal(revisionCount, 1);
      assert.deepEqual(publicHistory.items.map((event) => event.eventType), ['restore', 'delete']);
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

  test('deleted-page recovery previews a public source and restores it as a new monotonic revision', async () => {
    const fixture = await createFixture();
    let pageId: string | undefined;
    try {
      const created = await edits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code,
        title: `recovery_${fixture.unique}`,
        spaceId: fixture.space.id.toString(),
        contentRaw: '안전한 첫 판',
        editSummary: '첫 판'
      });
      pageId = created.pageId;
      const updated = await edits.updatePage(session(fixture.account.id), created.pageId, {
        contentRaw: '복구하지 않을 최신 판',
        editSummary: '두 번째 판',
        baseRevisionId: created.revisionId
      });
      await edits.deletePage(session(fixture.account.id), created.pageId, { reason: '복구 검증 삭제' });

      const recovery = await reads.getDeletedPageRecovery({
        pageId: created.pageId,
        viewer: session(fixture.account.id),
        revisionId: created.revisionId
      });
      assert.equal(recovery.selectedRevision.id, created.revisionId);
      assert.match(recovery.selectedRevision.html, /안전한 첫 판/u);
      assert.deepEqual(recovery.revisions.items.map((revision) => revision.id), [updated.revisionId, created.revisionId]);

      const restored = await edits.restorePage(session(fixture.account.id), created.pageId, {
        revisionId: created.revisionId,
        reason: '첫 판을 검토해 복구'
      });
      const [page, revision, lifecycle] = await Promise.all([
        prisma.wikiPage.findUniqueOrThrow({ where: { id: BigInt(created.pageId) } }),
        prisma.wikiPageRevision.findUniqueOrThrow({ where: { id: BigInt(restored.revisionId!) } }),
        prisma.wikiPageLifecycleEvent.findFirstOrThrow({ where: { pageId: BigInt(created.pageId), eventType: 'restore' } })
      ]);
      assert.equal(page.status, 'normal');
      assert.equal(page.currentRevisionId, revision.id);
      assert.equal(revision.revisionNo, 3);
      assert.equal(revision.parentRevisionId, BigInt(updated.revisionId));
      assert.equal(revision.contentRaw, '안전한 첫 판');
      assert.equal(restored.sourceRevisionId, created.revisionId);
      assert.equal(lifecycle.sourceRevisionId, BigInt(created.revisionId));
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
      assert.equal(updated.sectionAnchor, 's-1');
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

  test('moves a subtree across namespaces without replacing page-linked state and rebuilds current indexes', async () => {
    const fixture = await createFixture();
    const destinationCode = `d${fixture.unique.slice(0, 12)}`;
    const destinationNamespace = await prisma.wikiNamespace.create({
      data: {
        code: destinationCode,
        displayName: `Destination ${fixture.unique}`,
        pathPrefix: `/${destinationCode}`,
        isContent: true
      }
    });
    const destinationSpace = await prisma.wikiSpace.create({
      data: {
        code: `destination-${fixture.unique}`,
        spaceKey: `destination-${fixture.unique}`,
        name: `Destination ${fixture.unique}`,
        title: `Destination ${fixture.unique}`,
        slug: `destination-${fixture.unique}`,
        spaceType: 'basic',
        rootNamespaceCode: destinationCode,
        rootPath: `/${destinationCode}`,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date()
      }
    });
    const indexedEdits = new WikiEditService(prisma, profiles, permissions, undefined, new WikiLinkIndexService());
    let createdPageIds: bigint[] = [];
    try {
      const sourceTitle = `source_${fixture.unique}`;
      const childTitle = `${sourceTitle}/child`;
      const destinationTitle = `destination_${fixture.unique}`;
      const root = await indexedEdits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code,
        spaceId: fixture.space.id.toString(),
        title: sourceTitle,
        contentRaw: `[[도움말:index_${fixture.unique}]]`
      });
      const child = await indexedEdits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code,
        spaceId: fixture.space.id.toString(),
        title: childTitle,
        contentRaw: `[[분류:child_${fixture.unique}]]`
      });
      createdPageIds = [BigInt(root.pageId), BigInt(child.pageId)];
      const profile = await prisma.wikiProfile.findUniqueOrThrow({ where: { accountId: fixture.account.id } });
      const thread = await prisma.wikiDiscussionThread.create({
        data: {
          pageId: BigInt(root.pageId), title: 'Preserved discussion', status: 'open', createdBy: profile.id,
          createdAt: new Date(), updatedAt: new Date()
        }
      });
      const watch = await prisma.wikiPageWatch.create({
        data: {
          profileId: profile.id, pageId: BigInt(root.pageId), lastSeenRevisionId: BigInt(root.revisionId),
          createdAt: new Date(), updatedAt: new Date()
        }
      });
      const acl = await prisma.aclRule.create({
        data: {
          targetType: 'page', targetId: BigInt(root.pageId), action: 'read', effect: 'allow',
          subjectType: 'user', subjectValue: profile.id.toString(), sortOrder: 1,
          reason: 'preserve-on-move', createdBy: profile.id, createdAt: new Date(), updatedAt: new Date()
        }
      });
      await prisma.wikiPageLink.deleteMany({ where: { sourcePageId: { in: createdPageIds } } });
      await prisma.wikiPageLink.create({
        data: {
          sourcePageId: BigInt(root.pageId), sourceRevisionId: BigInt(root.revisionId),
          targetNamespaceCode: 'main', targetSlug: 'stale', linkType: 'link', createdAt: new Date()
        }
      });
      await prisma.wikiSearchDocument.updateMany({
        where: { pageId: { in: createdPageIds } },
        data: { searchVector: 'stale-index', updatedAt: new Date() }
      });

      const moved = await indexedEdits.movePage(session(fixture.account.id), root.pageId, {
        namespace: destinationCode,
        spaceId: destinationSpace.id.toString(),
        title: destinationTitle,
        leaveRedirect: true,
        reason: 'cross namespace fixture'
      });

      const [movedRoot, movedChild] = await Promise.all(createdPageIds.map((id) =>
        prisma.wikiPage.findUniqueOrThrow({ where: { id } })
      ));
      assert.equal(moved.pageId, root.pageId);
      assert.equal(moved.namespace, destinationCode);
      assert.equal(moved.previousNamespace, fixture.namespace.code);
      assert.equal(moved.previousSpaceId, fixture.space.id.toString());
      assert.equal(moved.spaceId, destinationSpace.id.toString());
      assert.equal(moved.movedPageCount, 2);
      assert.equal(movedRoot.namespaceId, destinationNamespace.id);
      assert.equal(movedChild.namespaceId, destinationNamespace.id);
      assert.equal(movedRoot.spaceId, destinationSpace.id);
      assert.equal(movedChild.spaceId, destinationSpace.id);
      assert.equal(movedRoot.id, BigInt(root.pageId));
      assert.equal(movedChild.id, BigInt(child.pageId));
      assert.equal(movedRoot.currentRevisionId, BigInt(root.revisionId));
      assert.equal(movedChild.currentRevisionId, BigInt(child.revisionId));
      assert.equal(movedRoot.title, destinationTitle);
      assert.equal(movedChild.title, `${destinationTitle}/child`);
      assert.equal(movedRoot.pageType, 'article');
      assert.equal(movedRoot.ownerProfileId, null);
      assert.ok(await prisma.wikiDiscussionThread.findUnique({ where: { id: thread.id } }));
      assert.ok(await prisma.wikiPageWatch.findUnique({ where: { id: watch.id } }));
      assert.ok(await prisma.aclRule.findUnique({ where: { id: acl.id } }));

      const searchDocuments = await prisma.wikiSearchDocument.findMany({ where: { pageId: { in: createdPageIds } } });
      assert.equal(searchDocuments.length, 2);
      assert.equal(searchDocuments.every((document) => document.searchVector !== 'stale-index'), true);
      const rootSearch = searchDocuments.find((document) => document.pageId === BigInt(root.pageId));
      const destinationTitleTerms = buildWikiSearchVector([destinationTitle]).split(' ');
      assert.ok(rootSearch);
      assert.equal(destinationTitleTerms.every((term) => rootSearch.searchVector.split(' ').includes(term)), true);
      const rootLinks = await prisma.wikiPageLink.findMany({ where: { sourcePageId: BigInt(root.pageId) } });
      assert.equal(rootLinks.some((link) => link.targetNamespaceCode === 'help' && link.targetSlug === `index_${fixture.unique}`), true);
      assert.equal(rootLinks.some((link) => link.targetSlug === 'stale'), false);

      const redirects = await prisma.wikiPage.findMany({
        where: { namespaceId: fixture.namespace.id, spaceId: fixture.space.id, pageType: 'redirect' }
      });
      assert.equal(redirects.length, 2);
      const rootRedirect = redirects.find((redirect) => redirect.localPath === sourceTitle);
      assert.ok(rootRedirect?.currentRevisionId);
      const redirectRevision = await prisma.wikiPageRevision.findUniqueOrThrow({ where: { id: rootRedirect!.currentRevisionId! } });
      assert.equal(redirectRevision.contentRaw, `#넘겨주기 [[${destinationCode}:${destinationTitle}]]`);
      const moveChanges = await prisma.wikiRecentChange.findMany({
        where: { pageId: { in: createdPageIds }, changeType: 'move' }
      });
      assert.equal(moveChanges.length, 2);
      assert.equal(moveChanges.every((change) => change.namespaceCode === destinationCode), true);
      assert.equal(moveChanges.every((change) => change.summary?.includes(
        `[${fixture.namespace.code}@${fixture.space.id.toString()} -> ${destinationCode}@${destinationSpace.id.toString()}]`
      )), true);
    } finally {
      const pages = await prisma.wikiPage.findMany({
        where: { OR: [{ spaceId: fixture.space.id }, { spaceId: destinationSpace.id }] },
        select: { id: true }
      });
      const pageIds = pages.map((page) => page.id);
      await prisma.wikiDiscussionThread.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiPageWatch.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.aclRule.deleteMany({ where: { targetType: 'page', targetId: { in: pageIds } } });
      await prisma.wikiRecentChange.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiPageLink.deleteMany({ where: { sourcePageId: { in: pageIds } } });
      await prisma.wikiSearchDocument.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiPageRenderCache.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiPageLifecycleEvent.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiPageRevision.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiPage.deleteMany({ where: { id: { in: pageIds } } });
      await prisma.wikiSpace.delete({ where: { id: destinationSpace.id } }).catch(() => {});
      await prisma.wikiNamespace.delete({ where: { id: destinationNamespace.id } }).catch(() => {});
      await cleanupFixture({
        accountId: fixture.account.id,
        namespaceId: fixture.namespace.id,
        namespaceCode: fixture.namespace.code,
        spaceId: fixture.space.id
      });
    }
  });

  test('destination collisions return 409 without partially moving a subtree', async () => {
    const fixture = await createFixture();
    const destinationCode = `c${fixture.unique.slice(0, 12)}`;
    const destinationNamespace = await prisma.wikiNamespace.create({
      data: { code: destinationCode, displayName: `Collision ${fixture.unique}`, pathPrefix: `/${destinationCode}`, isContent: true }
    });
    const destinationSpace = await prisma.wikiSpace.create({
      data: {
        code: `collision-${fixture.unique}`, spaceKey: `collision-${fixture.unique}`, name: `Collision ${fixture.unique}`,
        title: `Collision ${fixture.unique}`, slug: `collision-${fixture.unique}`, spaceType: 'basic',
        rootNamespaceCode: destinationCode, rootPath: `/${destinationCode}`, status: 'active',
        createdAt: new Date(), updatedAt: new Date()
      }
    });
    const indexedEdits = new WikiEditService(prisma, profiles, permissions, undefined, new WikiLinkIndexService());
    try {
      const sourceTitle = `collision_source_${fixture.unique}`;
      const targetTitle = `collision_target_${fixture.unique}`;
      const root = await indexedEdits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code, spaceId: fixture.space.id.toString(), title: sourceTitle, contentRaw: 'root'
      });
      const child = await indexedEdits.createPage(session(fixture.account.id), {
        namespace: fixture.namespace.code, spaceId: fixture.space.id.toString(), title: `${sourceTitle}/child`, contentRaw: 'child'
      });
      await indexedEdits.createPage(session(fixture.account.id), {
        namespace: destinationCode, spaceId: destinationSpace.id.toString(), title: targetTitle, contentRaw: 'occupied'
      });

      await assert.rejects(
        indexedEdits.movePage(session(fixture.account.id), root.pageId, {
          namespace: destinationCode, spaceId: destinationSpace.id.toString(), title: targetTitle, leaveRedirect: true
        }),
        (error: unknown) => error instanceof HttpException && error.getStatus() === 409
      );

      const [unchangedRoot, unchangedChild, moveCount, redirects] = await Promise.all([
        prisma.wikiPage.findUniqueOrThrow({ where: { id: BigInt(root.pageId) } }),
        prisma.wikiPage.findUniqueOrThrow({ where: { id: BigInt(child.pageId) } }),
        prisma.wikiRecentChange.count({ where: { pageId: { in: [BigInt(root.pageId), BigInt(child.pageId)] }, changeType: 'move' } }),
        prisma.wikiPage.count({ where: { namespaceId: fixture.namespace.id, pageType: 'redirect' } })
      ]);
      assert.equal(unchangedRoot.namespaceId, fixture.namespace.id);
      assert.equal(unchangedChild.namespaceId, fixture.namespace.id);
      assert.equal(unchangedRoot.spaceId, fixture.space.id);
      assert.equal(unchangedChild.spaceId, fixture.space.id);
      assert.equal(unchangedRoot.title, sourceTitle);
      assert.equal(unchangedChild.title, `${sourceTitle}/child`);
      assert.equal(moveCount, 0);
      assert.equal(redirects, 0);
    } finally {
      const pages = await prisma.wikiPage.findMany({
        where: { OR: [{ spaceId: fixture.space.id }, { spaceId: destinationSpace.id }] },
        select: { id: true }
      });
      const pageIds = pages.map((page) => page.id);
      await prisma.wikiRecentChange.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiPageLink.deleteMany({ where: { sourcePageId: { in: pageIds } } });
      await prisma.wikiSearchDocument.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiPageRenderCache.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiPageLifecycleEvent.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiPageRevision.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiPage.deleteMany({ where: { id: { in: pageIds } } });
      await prisma.wikiSpace.delete({ where: { id: destinationSpace.id } }).catch(() => {});
      await prisma.wikiNamespace.delete({ where: { id: destinationNamespace.id } }).catch(() => {});
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
