import { ConflictException } from '@nestjs/common';
import { isPublicWikiPageStatus } from '@minewiki/wiki-core/page-status';
import { Prisma } from '@prisma/client';
import { collectWikiFileNames, parseMarkup } from '@minewiki/wiki-core';
import { createHash } from 'node:crypto';
import type { PrismaService } from '../common/prisma.service';
import { buildCanonicalServerWikiPath } from '../wiki/wiki-route-path.resolver';

export type ServerWikiReleaseCandidatePageKind = 'added' | 'updated' | 'moved' | 'removed' | 'unchanged';

export interface ServerWikiReleaseCandidatePageIdentity {
  readonly revisionId: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly localPath: string;
  readonly routePath: string;
  readonly pageType: string;
  readonly protectionLevel: string;
  readonly status: string;
  readonly updatedAt: string;
}

export interface ServerWikiReleaseCandidate {
  readonly token: string;
  readonly baselineReleaseId: string | null;
  readonly generatedAt: string;
  readonly counts: Readonly<Record<ServerWikiReleaseCandidatePageKind, number>>;
  readonly pages: readonly {
    readonly pageId: string;
    readonly kind: ServerWikiReleaseCandidatePageKind;
    readonly contentChanged: boolean;
    readonly identityChanged: boolean;
    readonly metadataChanged: boolean;
    readonly before: ServerWikiReleaseCandidatePageIdentity | null;
    readonly after: ServerWikiReleaseCandidatePageIdentity | null;
    readonly updatedAt: string;
  }[];
  readonly presentation: {
    readonly navigationChanged: boolean;
    readonly contentSettingsChanged: boolean;
    readonly layoutChanged: boolean;
    readonly linkGraphChanged: boolean;
    readonly dependencyChanged: boolean;
    readonly accessChanged: boolean;
  };
  readonly hasChanges: boolean;
}

export interface ServerWikiPresentationSnapshot {
  readonly layoutKey: string;
  readonly navigationOrder: Prisma.JsonValue | null;
  readonly contributionPolicySource: string | null;
  readonly editHelpSource: string | null;
  readonly topNoticeSource: string | null;
  readonly bottomNoticeSource: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly seoIndexingEnabled: boolean;
  readonly brandName?: string | null;
  readonly brandLogoUrl?: string | null;
  readonly brandFaviconUrl?: string | null;
  readonly brandAccentColor?: string | null;
  readonly requireContributionPolicyAck: boolean;
  readonly contributionPolicyVersion: number;
  readonly contentSettingsVersion: number;
  readonly navigationVersion: number;
}

export interface ReleaseCandidateCurrentPage {
  readonly id: bigint;
  readonly namespaceId: number;
  readonly spaceId: bigint;
  readonly localPath: string;
  readonly slug: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly currentRevisionId: bigint;
  readonly pageType: string;
  readonly protectionLevel: string;
  readonly status: string;
  readonly createdBy: bigint | null;
  readonly ownerProfileId: bigint | null;
  readonly updatedAt: Date;
  readonly publicReadAllowed: boolean;
}

export interface ReleaseCandidateIncludeDependency {
  readonly sourcePageId: bigint;
  readonly sourceRevisionId: bigint;
  readonly targetNamespaceId: number;
  readonly targetNamespaceCode: string;
  readonly targetSlug: string;
  readonly targetPageId: bigint;
  readonly targetSpaceId: bigint;
  readonly targetRevisionId: bigint;
  readonly targetLocalPath: string;
  readonly targetTitle: string;
  readonly targetProtectionLevel: string;
  readonly targetPageStatus: string;
  readonly targetCreatedBy: bigint | null;
  readonly targetOwnerProfileId: bigint | null;
  readonly contentRaw: string;
  readonly contentHash: string;
  readonly contentSize: number;
  readonly publicReadAllowed: boolean;
}

export interface ReleaseCandidateAsset {
  readonly wikiFilename: string;
  readonly uploadedFileId: string;
  readonly wikiFileVersionId: bigint | null;
  readonly sha256: string;
  readonly publicPath: string;
  readonly mimeType: string;
  readonly originalName: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly license: string | null;
  readonly sourceUrl: string | null;
  readonly sourceText: string | null;
  readonly publicReadAllowed: boolean;
}

export interface ReleaseCandidateLink {
  readonly sourcePageId: bigint;
  readonly sourceRevisionId: bigint;
  readonly targetNamespaceCode: string;
  readonly targetSlug: string;
  readonly linkType: string;
  readonly categoryLabel: string | null;
  readonly categoryBlurred: boolean;
}

export interface ReleaseCandidateSnapshot {
  readonly snapshotVersion: 1 | 2 | 3;
  readonly candidate: ServerWikiReleaseCandidate;
  readonly presentation: ServerWikiPresentationSnapshot;
  readonly pages: readonly ReleaseCandidateCurrentPage[];
  readonly revisionContentByPageId: ReadonlyMap<bigint, string>;
  readonly links: readonly ReleaseCandidateLink[];
  readonly includeDependencies: readonly ReleaseCandidateIncludeDependency[];
  readonly assets: readonly ReleaseCandidateAsset[];
}

export interface ReleaseCandidateInput {
  readonly serverWikiId: bigint;
  readonly spaceId: bigint;
  readonly siteSlug: string;
  readonly contentSlug: string;
  readonly publishedRelease: {
    readonly id: bigint;
    readonly presentationSnapshot: Prisma.JsonValue;
  } | null;
  readonly presentation: ServerWikiPresentationSnapshot;
  readonly resolvePublicReadAllowed?: (
    page: Omit<ReleaseCandidateCurrentPage, 'publicReadAllowed'>,
    revision: { readonly id: bigint; readonly pageId: bigint; readonly visibility: string },
  ) => Promise<boolean>;
}

export async function buildServerWikiReleaseCandidate(
  store: Prisma.TransactionClient | PrismaService,
  input: ReleaseCandidateInput,
  lock: boolean,
): Promise<ReleaseCandidateSnapshot> {
  if (lock) {
    await store.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM pages WHERE space_id = ${input.spaceId} ORDER BY id FOR UPDATE
    `;
  }
  const pageRows = await loadCurrentPages(store, input.spaceId);
  const revisionIds = pageRows.flatMap((page) => page.currentRevisionId ? [page.currentRevisionId] : []);
  const revisions = revisionIds.length > 0
    ? await store.wikiPageRevision.findMany({
        where: { id: { in: revisionIds }, visibility: 'public' },
        select: { id: true, pageId: true, contentRaw: true, contentHash: true, contentSize: true, visibility: true },
      })
    : [];
  const revisionByKey = new Map(revisions.map((revision) => [`${revision.pageId}:${revision.id}`, revision]));
  const pages: ReleaseCandidateCurrentPage[] = [];
  for (const page of pageRows) {
    if (page.currentRevisionId === null || !isPublicWikiPageStatus(page.status)) continue;
    const revision = revisionByKey.get(`${page.id}:${page.currentRevisionId}`);
    if (!revision) continue;
    const candidatePage = { ...page, currentRevisionId: page.currentRevisionId };
    const publicReadAllowed = input.resolvePublicReadAllowed
      ? await input.resolvePublicReadAllowed(candidatePage, revision)
      : true;
    if (!publicReadAllowed) continue;
    pages.push({
      ...candidatePage,
      publicReadAllowed,
    });
  }
  if (pages.some((page) => page.spaceId !== input.spaceId)) {
    throw new ConflictException('Server wiki release candidate is inconsistent.');
  }
  const revisionContentByPageId = new Map(pages.map((page) => [
    page.id,
    revisionByKey.get(`${page.id}:${page.currentRevisionId}`)?.contentRaw ?? '',
  ]));
  const links = await loadCurrentLinks(store, pages);
  const currentRevisionByPageId = new Map(pages.map((page) => [page.id, page.currentRevisionId]));
  if (links.some((link) => currentRevisionByPageId.get(link.sourcePageId) !== link.sourceRevisionId)) {
    throw new ConflictException('Server wiki release candidate link graph is inconsistent.');
  }
  const includeDependencies = await loadIncludeDependencies(store, links, input.resolvePublicReadAllowed);
  const assets = await loadReleaseAssets(store, pages, revisionContentByPageId, includeDependencies);

  const baselineItems = input.publishedRelease
    ? await store.serverWikiReleaseItem.findMany({
        where: { releaseId: input.publishedRelease.id, serverWikiId: input.serverWikiId, spaceId: input.spaceId },
        orderBy: [{ pageId: 'asc' }],
      })
    : [];
  const baselineLinks = input.publishedRelease
    ? await store.serverWikiReleaseLink.findMany({
        where: { releaseId: input.publishedRelease.id, serverWikiId: input.serverWikiId, spaceId: input.spaceId },
        orderBy: [{ sourcePageId: 'asc' }, { targetNamespaceCode: 'asc' }, { targetSlug: 'asc' }, { linkType: 'asc' }],
        select: linkSelection,
      })
    : [];
  const baselineIncludes = input.publishedRelease
    ? await optionalReleaseRows<ReleaseCandidateIncludeDependency>(store, 'serverWikiReleaseInclude', input.publishedRelease.id)
    : [];
  const baselineAssets = input.publishedRelease
    ? await optionalReleaseRows<ReleaseCandidateAsset>(store, 'serverWikiReleaseAsset', input.publishedRelease.id)
    : [];
  const baselineByPageId = new Map(baselineItems.map((item) => [item.pageId, item]));
  const currentByPageId = new Map(pages.map((page) => [page.id, page]));
  const pageIds = [...new Set([...baselineByPageId.keys(), ...currentByPageId.keys()])]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const candidatePages = pageIds.map((pageId) => {
    const beforePage = baselineByPageId.get(pageId);
    const afterPage = currentByPageId.get(pageId);
    const contentChanged = Boolean(beforePage && afterPage && beforePage.revisionId !== afterPage.currentRevisionId);
    const identityChanged = Boolean(beforePage && afterPage && (
      beforePage.namespaceId !== afterPage.namespaceId
      || beforePage.localPath !== afterPage.localPath
      || beforePage.slug !== afterPage.slug
      || beforePage.title !== afterPage.title
      || beforePage.displayTitle !== afterPage.displayTitle
    ));
    const metadataChanged = Boolean(beforePage && afterPage && (
      beforePage.pageType !== afterPage.pageType
      || beforePage.protectionLevel !== afterPage.protectionLevel
      || beforePage.pageStatus !== afterPage.status
      || beforePage.createdBy !== afterPage.createdBy
      || beforePage.ownerProfileId !== afterPage.ownerProfileId
      || beforePage.pageUpdatedAt.getTime() !== afterPage.updatedAt.getTime()
    ));
    const kind: ServerWikiReleaseCandidatePageKind = !beforePage
      ? 'added'
      : !afterPage
        ? 'removed'
        : identityChanged
          ? 'moved'
          : contentChanged || metadataChanged
            ? 'updated'
            : 'unchanged';
    return {
      pageId: pageId.toString(),
      kind,
      contentChanged,
      identityChanged,
      metadataChanged,
      before: beforePage ? candidateIdentity(input, {
        revisionId: beforePage.revisionId,
        title: beforePage.title,
        displayTitle: beforePage.displayTitle,
        localPath: beforePage.localPath,
        pageType: beforePage.pageType,
        protectionLevel: beforePage.protectionLevel,
        status: beforePage.pageStatus,
        updatedAt: beforePage.pageUpdatedAt,
      }) : null,
      after: afterPage ? candidateIdentity(input, {
        revisionId: afterPage.currentRevisionId,
        title: afterPage.title,
        displayTitle: afterPage.displayTitle,
        localPath: afterPage.localPath,
        pageType: afterPage.pageType,
        protectionLevel: afterPage.protectionLevel,
        status: afterPage.status,
        updatedAt: afterPage.updatedAt,
      }) : null,
      updatedAt: (afterPage?.updatedAt ?? beforePage?.pageUpdatedAt ?? new Date(0)).toISOString(),
    };
  });
  const counts = candidateCounts(candidatePages);
  const baselinePresentation = parsePresentationSnapshot(input.publishedRelease?.presentationSnapshot);
  const dependencyChanged = !jsonEqual(includeFingerprint(baselineIncludes), includeFingerprint(includeDependencies))
    || !jsonEqual(assetFingerprint(baselineAssets), assetFingerprint(assets));
  const accessChanged = pages.some((page) => {
    const baseline = baselineByPageId.get(page.id);
    return baseline ? (baseline.publicReadAllowed ?? true) !== page.publicReadAllowed : false;
  });
  const presentation = {
    ...presentationChanges(input.presentation, baselinePresentation, links, baselineLinks),
    dependencyChanged,
    accessChanged,
  };
  const token = createHash('sha256').update(canonicalJson({
    snapshotVersion: 3,
    serverWikiId: input.serverWikiId.toString(),
    siteSlug: input.siteSlug,
    contentSlug: input.contentSlug,
    baselineReleaseId: input.publishedRelease?.id.toString() ?? null,
    pages: pages.map(tokenPage),
    presentation: input.presentation,
    links: linkFingerprint(links),
    publicAccess: pages.map((page) => [page.id.toString(), page.publicReadAllowed]),
    includes: includeFingerprint(includeDependencies),
    assets: assetFingerprint(assets),
  })).digest('hex');
  const hasChanges = counts.added + counts.updated + counts.moved + counts.removed > 0
    || Object.values(presentation).some(Boolean);
  return {
    snapshotVersion: 3,
    candidate: {
      token,
      baselineReleaseId: input.publishedRelease?.id.toString() ?? null,
      generatedAt: new Date().toISOString(),
      counts,
      pages: candidatePages,
      presentation,
      hasChanges,
    },
    presentation: input.presentation,
    pages,
    revisionContentByPageId,
    links,
    includeDependencies,
    assets,
  };
}

const linkSelection = {
  sourcePageId: true,
  sourceRevisionId: true,
  targetNamespaceCode: true,
  targetSlug: true,
  linkType: true,
  categoryLabel: true,
  categoryBlurred: true,
} as const;

async function loadCurrentPages(store: Prisma.TransactionClient | PrismaService, spaceId: bigint) {
  return store.wikiPage.findMany({
    where: {
      spaceId,
      status: { in: ['normal', 'active', 'published', 'protected'] },
      currentRevisionId: { not: null },
    },
    orderBy: [{ id: 'asc' }],
    select: {
      id: true, namespaceId: true, spaceId: true, localPath: true, slug: true, title: true,
      displayTitle: true, currentRevisionId: true, pageType: true, protectionLevel: true,
      status: true, createdBy: true, ownerProfileId: true, updatedAt: true,
    },
  });
}

async function loadCurrentLinks(
  store: Prisma.TransactionClient | PrismaService,
  pages: readonly ReleaseCandidateCurrentPage[],
): Promise<ReleaseCandidateLink[]> {
  return pages.length > 0
    ? store.wikiPageLink.findMany({
        where: { OR: pages.map((page) => ({ sourcePageId: page.id, sourceRevisionId: page.currentRevisionId })) },
        orderBy: [{ sourcePageId: 'asc' }, { targetNamespaceCode: 'asc' }, { targetSlug: 'asc' }, { linkType: 'asc' }],
        select: linkSelection,
      })
    : [];
}

async function loadIncludeDependencies(
  store: Prisma.TransactionClient | PrismaService,
  links: readonly ReleaseCandidateLink[],
  resolvePublicReadAllowed: ReleaseCandidateInput['resolvePublicReadAllowed'],
): Promise<ReleaseCandidateIncludeDependency[]> {
  const requested = links.filter((link) => link.linkType === 'include' && link.targetNamespaceCode !== 'server');
  if (requested.length === 0) return [];
  const namespaceCodes = [...new Set(requested.map((link) => link.targetNamespaceCode))];
  const namespaces = await store.wikiNamespace.findMany({
    where: { code: { in: namespaceCodes } },
    select: { id: true, code: true },
  });
  const namespaceByCode = new Map(namespaces.map((namespace) => [namespace.code, namespace]));
  const dependencies: ReleaseCandidateIncludeDependency[] = [];
  for (const link of requested) {
    const namespace = namespaceByCode.get(link.targetNamespaceCode);
    if (!namespace) continue;
    const page = await store.wikiPage.findUnique({
      where: { namespaceId_slug: { namespaceId: namespace.id, slug: link.targetSlug } },
      select: {
        id: true, namespaceId: true, spaceId: true, localPath: true, slug: true, title: true,
        displayTitle: true, currentRevisionId: true, pageType: true, protectionLevel: true,
        status: true, createdBy: true, ownerProfileId: true, updatedAt: true,
      },
    });
    if (!page?.currentRevisionId || !isPublicWikiPageStatus(page.status)) continue;
    const revision = await store.wikiPageRevision.findFirst({
      where: { id: page.currentRevisionId, pageId: page.id, visibility: 'public' },
      select: {
        id: true, pageId: true, contentRaw: true, contentHash: true, contentSize: true, visibility: true,
      },
    });
    if (!revision) continue;
    const candidatePage = { ...page, currentRevisionId: page.currentRevisionId };
    dependencies.push({
      sourcePageId: link.sourcePageId,
      sourceRevisionId: link.sourceRevisionId,
      targetNamespaceId: namespace.id,
      targetNamespaceCode: namespace.code,
      targetSlug: link.targetSlug,
      targetPageId: page.id,
      targetSpaceId: page.spaceId,
      targetRevisionId: revision.id,
      targetLocalPath: page.localPath,
      targetTitle: page.title,
      targetProtectionLevel: page.protectionLevel,
      targetPageStatus: page.status,
      targetCreatedBy: page.createdBy,
      targetOwnerProfileId: page.ownerProfileId,
      contentRaw: revision.contentRaw,
      contentHash: revision.contentHash,
      contentSize: revision.contentSize,
      publicReadAllowed: resolvePublicReadAllowed
        ? await resolvePublicReadAllowed(candidatePage, revision)
        : true,
    });
  }
  return dependencies.sort((left, right) => includeKey(left).localeCompare(includeKey(right)));
}

async function loadReleaseAssets(
  store: Prisma.TransactionClient | PrismaService,
  pages: readonly ReleaseCandidateCurrentPage[],
  revisionContentByPageId: ReadonlyMap<bigint, string>,
  includes: readonly ReleaseCandidateIncludeDependency[],
): Promise<ReleaseCandidateAsset[]> {
  const names = new Set<string>();
  for (const content of [
    ...pages.map((page) => revisionContentByPageId.get(page.id) ?? ''),
    ...includes.map((dependency) => dependency.contentRaw),
  ]) {
    const parsed = parseMarkup(content);
    for (const name of collectWikiFileNames(parsed.ast)) names.add(name);
  }
  if (names.size === 0) return [];
  const files = await store.uploadedFile.findMany({
    where: {
      currentWikiFilename: { in: [...names] },
      usageContext: 'wiki_editor',
      status: 'active',
    },
    orderBy: [{ currentWikiFilename: 'asc' }, { id: 'asc' }],
  });
  const fileIds = files.map((file) => file.id);
  const versions = fileIds.length > 0
    ? await store.wikiFileVersion.findMany({
        where: { uploadedFileId: { in: fileIds }, isCurrent: true },
        select: { id: true, uploadedFileId: true },
      })
    : [];
  const versionByFileId = new Map(versions.map((version) => [version.uploadedFileId, version.id]));
  const pageIds = new Set(pages.map((page) => page.id.toString()));
  const spaceIds = new Set(pages.map((page) => page.spaceId.toString()));
  return files.flatMap((file): ReleaseCandidateAsset[] => {
    const wikiFilename = file.currentWikiFilename ?? file.wikiFilename;
    if (!wikiFilename) return [];
    const linkedId = file.linkedResourceId?.trim() ?? '';
    const publicReadAllowed = ['public', 'unlisted'].includes(file.visibility)
      || (file.visibility === 'restricted' && (
        (file.linkedResourceType === 'wiki_page' && pageIds.has(linkedId))
        || (file.linkedResourceType === 'wiki_space' && spaceIds.has(linkedId))
      ));
    return [{
      wikiFilename,
      uploadedFileId: file.id,
      wikiFileVersionId: versionByFileId.get(file.id) ?? null,
      sha256: file.sha256,
      publicPath: file.publicPath,
      mimeType: file.mimeType,
      originalName: file.originalName ?? file.filename,
      sizeBytes: file.sizeBytes,
      width: file.width,
      height: file.height,
      license: file.license,
      sourceUrl: file.sourceUrl,
      sourceText: file.sourceText,
      publicReadAllowed,
    }];
  }).sort((left, right) => left.wikiFilename.localeCompare(right.wikiFilename));
}

async function optionalReleaseRows<T>(
  store: Prisma.TransactionClient | PrismaService,
  delegateName: 'serverWikiReleaseInclude' | 'serverWikiReleaseAsset',
  releaseId: bigint,
): Promise<T[]> {
  const delegate = (store as unknown as Record<string, { findMany?: (args: unknown) => Promise<T[]> }>)[delegateName];
  return delegate?.findMany ? delegate.findMany({ where: { releaseId } }) : [];
}

function candidateIdentity(
  input: Pick<ReleaseCandidateInput, 'siteSlug' | 'contentSlug'>,
  page: {
    readonly revisionId: bigint;
    readonly title: string;
    readonly displayTitle: string;
    readonly localPath: string;
    readonly pageType: string;
    readonly protectionLevel: string;
    readonly status: string;
    readonly updatedAt: Date;
  },
): ServerWikiReleaseCandidatePageIdentity {
  return {
    revisionId: page.revisionId.toString(),
    title: page.title,
    displayTitle: page.displayTitle,
    localPath: page.localPath,
    routePath: buildCanonicalServerWikiPath(input.siteSlug, page.localPath, input.contentSlug, '/serverWiki'),
    pageType: page.pageType,
    protectionLevel: page.protectionLevel,
    status: page.status,
    updatedAt: page.updatedAt.toISOString(),
  };
}

function candidateCounts(pages: readonly { readonly kind: ServerWikiReleaseCandidatePageKind }[]) {
  return {
    added: pages.filter((page) => page.kind === 'added').length,
    updated: pages.filter((page) => page.kind === 'updated').length,
    moved: pages.filter((page) => page.kind === 'moved').length,
    removed: pages.filter((page) => page.kind === 'removed').length,
    unchanged: pages.filter((page) => page.kind === 'unchanged').length,
  };
}

function presentationChanges(
  current: ServerWikiPresentationSnapshot,
  baseline: Partial<ServerWikiPresentationSnapshot> | null,
  links: readonly ReleaseCandidateLink[],
  baselineLinks: readonly ReleaseCandidateLink[],
) {
  return {
    navigationChanged: !jsonEqual(baseline?.navigationOrder ?? null, current.navigationOrder),
    contentSettingsChanged: !baseline || [
      'contributionPolicySource', 'editHelpSource', 'topNoticeSource', 'bottomNoticeSource',
      'requireContributionPolicyAck', 'contributionPolicyVersion', 'contentSettingsVersion',
      'brandName', 'brandLogoUrl', 'brandFaviconUrl', 'brandAccentColor',
    ].some((key) => !jsonEqual(
      baseline[key as keyof ServerWikiPresentationSnapshot] ?? null,
      current[key as keyof ServerWikiPresentationSnapshot] ?? null,
    ))
      || !jsonEqual(baseline?.seoTitle ?? null, current.seoTitle ?? null)
      || !jsonEqual(baseline?.seoDescription ?? null, current.seoDescription ?? null)
      || !jsonEqual(baseline?.seoIndexingEnabled ?? true, current.seoIndexingEnabled ?? true),
    layoutChanged: !baseline || baseline.layoutKey !== current.layoutKey,
    linkGraphChanged: !jsonEqual(linkFingerprint(baselineLinks), linkFingerprint(links)),
  };
}

function tokenPage(page: ReleaseCandidateCurrentPage) {
  return {
    pageId: page.id.toString(), revisionId: page.currentRevisionId.toString(), namespaceId: page.namespaceId,
    localPath: page.localPath, slug: page.slug, title: page.title, displayTitle: page.displayTitle,
    pageType: page.pageType, protectionLevel: page.protectionLevel, status: page.status,
    createdBy: page.createdBy?.toString() ?? null, ownerProfileId: page.ownerProfileId?.toString() ?? null,
    updatedAt: page.updatedAt.toISOString(),
  };
}

function linkFingerprint(links: readonly ReleaseCandidateLink[]): readonly string[] {
  return links.map((link) => [
    link.sourcePageId.toString(), link.sourceRevisionId.toString(), link.targetNamespaceCode,
    link.targetSlug, link.linkType, link.categoryLabel ?? '', String(link.categoryBlurred ?? false),
  ].join('\u0000')).sort();
}

function includeKey(include: Pick<ReleaseCandidateIncludeDependency,
  'sourcePageId' | 'targetNamespaceCode' | 'targetSlug'>): string {
  return [include.sourcePageId.toString(), include.targetNamespaceCode, include.targetSlug].join('\u0000');
}

function includeFingerprint(includes: readonly ReleaseCandidateIncludeDependency[]): readonly string[] {
  return includes.map((include) => [
    includeKey(include), include.sourceRevisionId.toString(), include.targetPageId.toString(),
    include.targetSpaceId.toString(), include.targetRevisionId.toString(), include.contentHash, String(include.contentSize),
    String(include.publicReadAllowed),
  ].join('\u0000')).sort();
}

function assetFingerprint(assets: readonly ReleaseCandidateAsset[]): readonly string[] {
  return assets.map((asset) => [
    asset.wikiFilename, asset.uploadedFileId, asset.wikiFileVersionId?.toString() ?? '',
    asset.sha256, asset.publicPath, asset.mimeType, asset.originalName, String(asset.sizeBytes),
    asset.width?.toString() ?? '', asset.height?.toString() ?? '', asset.license ?? '',
    asset.sourceUrl ?? '', asset.sourceText ?? '', String(asset.publicReadAllowed),
  ].join('\u0000')).sort();
}

function parsePresentationSnapshot(value: Prisma.JsonValue | undefined): Partial<ServerWikiPresentationSnapshot> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<ServerWikiPresentationSnapshot>
    : null;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]));
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}
