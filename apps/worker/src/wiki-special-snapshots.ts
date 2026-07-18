import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { parseLinkTarget, parseMarkup, slugifyTitle, wikiUrl, type NamespaceCode, type WikiLinkResolutionContext } from '@minewiki/wiki-core';

const MAX_SNAPSHOT_ITEMS = 50_000;
const MAX_SNAPSHOT_SOURCE_CONTRIBUTIONS = 50_000;
export const WIKI_SPECIAL_SNAPSHOT_PROJECTION_VERSION = 2;
const PUBLIC_PAGE_STATUSES = new Set(['normal', 'active', 'published']);
const PUBLIC_READ_PROTECTION_LEVELS = new Set([
  'open', 'login_required', 'review_required', 'autoconfirmed_only', 'trusted_only',
  'official_only', 'owner_only', 'admin_only', 'locked'
]);

type SnapshotType = 'orphaned' | 'orphaned_categories' | 'wanted' | 'categories';

export interface SnapshotPage {
  readonly id: bigint;
  readonly namespaceId: number;
  readonly spaceId: bigint;
  readonly localPath: string;
  readonly slug: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly currentRevisionId: bigint | null;
  readonly pageType: string;
  readonly protectionLevel: string;
  readonly status: string;
  readonly updatedAt: Date;
}

export interface SnapshotLink {
  readonly sourcePageId: bigint;
  readonly sourceRevisionId: bigint;
  readonly targetNamespaceCode: string;
  readonly targetSlug: string;
  readonly linkType: string;
}

export interface SnapshotAclRule {
  readonly targetType: string;
  readonly targetId: bigint | null;
  readonly subjectType: string;
  readonly subjectValue: string;
  readonly effect: string;
  readonly sortOrder: number;
}

export interface SnapshotItem {
  readonly id: string;
  readonly pageId: string | null;
  readonly namespace: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly routePath: string;
  readonly value: number | null;
  readonly updatedAt: string | null;
  /** Internal ACL-recomputation metadata. The API strips this from responses. */
  readonly sourceContributions?: ReadonlyArray<{
    readonly pageId: string;
    readonly count: number;
  }>;
  readonly sourceContributionsComplete?: boolean;
}

export interface SnapshotRow {
  readonly type: SnapshotType;
  readonly namespaceCode: string;
  readonly generation: string;
  readonly items: SnapshotItem[];
  readonly sourcePageCount: number;
  readonly sourceLinkCount: number;
  readonly generatedAt: Date;
}

export interface SnapshotServerWiki {
  readonly id: bigint;
  readonly spaceId: bigint;
  readonly slug: string;
  readonly siteSlug: string | null;
  readonly status: string;
  readonly publicationStatus: string;
  readonly publishedReleaseId: bigint | null;
}

export interface SnapshotReleaseItem {
  readonly releaseId: bigint;
  readonly serverWikiId: bigint;
  readonly spaceId: bigint;
  readonly namespaceId: number;
  readonly pageId: bigint;
  readonly revisionId: bigint;
  readonly localPath: string;
  readonly slug: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly pageType: string;
  readonly protectionLevel: string;
  readonly pageStatus: string;
  readonly pageUpdatedAt: Date;
}

export interface SnapshotRevision {
  readonly id: bigint;
  readonly pageId: bigint;
  readonly visibility: string;
  readonly contentRaw: string;
}

interface SnapshotServerRoute {
  readonly siteSlug: string;
  readonly contentRootSlug: string;
}

export function buildWikiSpecialSnapshotRows(input: {
  readonly pages: readonly SnapshotPage[];
  readonly links: readonly SnapshotLink[];
  readonly namespaces: ReadonlyArray<{ readonly id: number; readonly code: string }>;
  readonly activeSpaceIds: ReadonlySet<bigint>;
  readonly rootPageIds: ReadonlySet<bigint>;
  readonly serverRouteBySpaceId: ReadonlyMap<bigint, SnapshotServerRoute>;
  readonly aclRules: readonly SnapshotAclRule[];
  readonly generatedAt?: Date;
  readonly generation?: string;
}): SnapshotRow[] {
  const generatedAt = input.generatedAt ?? new Date();
  const generation = input.generation ?? randomUUID();
  const namespaceById = new Map(input.namespaces.map((namespace) => [namespace.id, namespace.code]));
  const rulesByTarget = indexAclRules(input.aclRules);
  const visiblePages = input.pages.filter((page) =>
    page.currentRevisionId !== null &&
    page.pageType !== 'redirect' &&
    PUBLIC_READ_PROTECTION_LEVELS.has(page.protectionLevel) &&
    PUBLIC_PAGE_STATUSES.has(page.status) &&
    input.activeSpaceIds.has(page.spaceId) &&
    genericAnonymousReadAllowed(page, rulesByTarget)
  );
  const visiblePageById = new Map(visiblePages.map((page) => [page.id, page]));
  const currentLinks = input.links.filter((link) =>
    visiblePageById.get(link.sourcePageId)?.currentRevisionId === link.sourceRevisionId
  );
  const existingPageKeys = new Set(visiblePages.map((page) => pageKey(
    namespaceById.get(page.namespaceId) ?? 'main',
    page.slug,
    page.spaceId
  )));
  const scopes = ['', ...input.namespaces.map((namespace) => namespace.code)];
  const rows: SnapshotRow[] = [];

  for (const namespaceCode of scopes) {
    const scopePages = namespaceCode
      ? visiblePages.filter((page) => namespaceById.get(page.namespaceId) === namespaceCode)
      : visiblePages;
    const scopePageIds = new Set(scopePages.map((page) => page.id));
    const scopeLinks = currentLinks.filter((link) => scopePageIds.has(link.sourcePageId));
    rows.push(snapshotRow('orphaned', namespaceCode, orphanedItems(
      scopePages,
      scopeLinks,
      namespaceById,
      input.rootPageIds,
      input.serverRouteBySpaceId
    ), scopePages, scopeLinks, generation, generatedAt));
    rows.push(snapshotRow('wanted', namespaceCode, wantedItems(
      scopeLinks,
      visiblePageById,
      existingPageKeys,
      input.serverRouteBySpaceId
    ), scopePages, scopeLinks, generation, generatedAt));
    rows.push(snapshotRow('categories', namespaceCode, categoryItems(scopeLinks), scopePages, scopeLinks, generation, generatedAt));
    if (!namespaceCode || namespaceCode === 'category') {
      const categoryPages = scopePages.filter((page) => namespaceById.get(page.namespaceId) === 'category');
      const categoryPageIds = new Set(categoryPages.map((page) => page.id));
      const categoryLinks = scopeLinks.filter((link) => categoryPageIds.has(link.sourcePageId));
      rows.push(snapshotRow('orphaned_categories', namespaceCode, orphanedCategoryItems(
        categoryPages,
        categoryLinks,
        input.serverRouteBySpaceId
      ), categoryPages, categoryLinks, generation, generatedAt));
    }
  }
  return rows;
}

export async function rebuildWikiSpecialSnapshots(prisma: PrismaClient): Promise<{
  readonly generation: string;
  readonly rows: number;
  readonly sourcePages: number;
  readonly sourceLinks: number;
}> {
  const now = new Date();
  const [pages, links, namespaces, spaces, serverWikis, aclRules] = await Promise.all([
    prisma.wikiPage.findMany({
      where: {
        status: { in: ['normal', 'active', 'published'] },
        pageType: { not: 'redirect' },
        currentRevisionId: { not: null }
      },
      select: {
        id: true, namespaceId: true, spaceId: true, localPath: true, slug: true, title: true,
        displayTitle: true, currentRevisionId: true, pageType: true, protectionLevel: true,
        status: true, updatedAt: true
      }
    }),
    prisma.wikiPageLink.findMany({
      select: {
        sourcePageId: true, sourceRevisionId: true, targetNamespaceCode: true, targetSlug: true, linkType: true
      }
    }),
    prisma.wikiNamespace.findMany({ select: { id: true, code: true } }),
    prisma.wikiSpace.findMany({
      where: { status: 'active' },
      select: { id: true, rootPageId: true }
    }),
    prisma.serverWiki.findMany({
      select: {
        id: true,
        spaceId: true,
        slug: true,
        siteSlug: true,
        status: true,
        publicationStatus: true,
        publishedReleaseId: true,
      }
    }),
    prisma.aclRule.findMany({
      where: {
        action: 'read',
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
      },
      select: {
        targetType: true, targetId: true, subjectType: true, subjectValue: true,
        effect: true, sortOrder: true
      }
    })
  ]);
  const publishedWikis = serverWikis.filter((wiki) =>
    wiki.status === 'active'
    && wiki.publicationStatus === 'published'
    && wiki.publishedReleaseId !== null);
  const releaseItems = publishedWikis.length > 0
    ? await prisma.serverWikiReleaseItem.findMany({
        where: {
          OR: publishedWikis.map((wiki) => ({
            releaseId: wiki.publishedReleaseId!,
            serverWikiId: wiki.id,
            spaceId: wiki.spaceId,
          })),
        },
        select: {
          releaseId: true,
          serverWikiId: true,
          spaceId: true,
          namespaceId: true,
          pageId: true,
          revisionId: true,
          localPath: true,
          slug: true,
          title: true,
          displayTitle: true,
          pageType: true,
          protectionLevel: true,
          pageStatus: true,
          pageUpdatedAt: true,
        },
      })
    : [];
  const revisionIds = [...new Set(releaseItems.map((item) => item.revisionId))];
  const releaseRevisions = revisionIds.length > 0
    ? await prisma.wikiPageRevision.findMany({
        where: { id: { in: revisionIds }, visibility: 'public' },
        select: { id: true, pageId: true, visibility: true, contentRaw: true },
      })
    : [];
  const projection = projectWikiSpecialSnapshotSources({
    pages,
    links,
    namespaces,
    serverWikis,
    releaseItems,
    releaseRevisions,
  });
  const generation = randomUUID();
  const rows = buildWikiSpecialSnapshotRows({
    pages: projection.pages,
    links: projection.links,
    namespaces,
    activeSpaceIds: new Set(spaces.map((space) => space.id)),
    rootPageIds: new Set(spaces.flatMap((space) => space.rootPageId ? [space.rootPageId] : [])),
    serverRouteBySpaceId: projection.serverRouteBySpaceId,
    aclRules,
    generatedAt: now,
    generation
  });
  await prisma.$transaction(rows.map((row) => prisma.wikiSpecialSnapshot.upsert({
    where: { type_namespaceCode: { type: row.type, namespaceCode: row.namespaceCode } },
    create: {
      type: row.type,
      namespaceCode: row.namespaceCode,
      generation: row.generation,
      items: snapshotEnvelope(row.items) as unknown as Prisma.InputJsonValue,
      sourcePageCount: row.sourcePageCount,
      sourceLinkCount: row.sourceLinkCount,
      generatedAt: row.generatedAt
    },
    update: {
      generation: row.generation,
      items: snapshotEnvelope(row.items) as unknown as Prisma.InputJsonValue,
      sourcePageCount: row.sourcePageCount,
      sourceLinkCount: row.sourceLinkCount,
      generatedAt: row.generatedAt
    }
  })));
  return {
    generation,
    rows: rows.length,
    sourcePages: projection.pages.length,
    sourceLinks: projection.links.length,
  };
}

export function projectWikiSpecialSnapshotSources(input: {
  readonly pages: readonly SnapshotPage[];
  readonly links: readonly SnapshotLink[];
  readonly namespaces: ReadonlyArray<{ readonly id: number; readonly code: string }>;
  readonly serverWikis: readonly SnapshotServerWiki[];
  readonly releaseItems: readonly SnapshotReleaseItem[];
  readonly releaseRevisions: readonly SnapshotRevision[];
}): {
  readonly pages: SnapshotPage[];
  readonly links: SnapshotLink[];
  readonly serverRouteBySpaceId: ReadonlyMap<bigint, SnapshotServerRoute>;
} {
  const namespaceById = new Map(input.namespaces.map((namespace) => [namespace.id, namespace.code]));
  const serverSpaceIds = new Set(input.serverWikis.map((wiki) => wiki.spaceId));
  const ordinaryPages = input.pages.filter((page) =>
    namespaceById.get(page.namespaceId) !== 'server' && !serverSpaceIds.has(page.spaceId));
  const ordinaryPageIds = new Set(ordinaryPages.map((page) => page.id));
  const ordinaryLinks = input.links.filter((link) => ordinaryPageIds.has(link.sourcePageId));
  const publishedWikiBySpaceId = new Map(input.serverWikis
    .filter((wiki) => wiki.status === 'active'
      && wiki.publicationStatus === 'published'
      && wiki.publishedReleaseId !== null)
    .map((wiki) => [wiki.spaceId, wiki]));
  const revisionByKey = new Map(input.releaseRevisions
    .filter((revision) => revision.visibility === 'public')
    .map((revision) => [`${revision.pageId}:${revision.id}`, revision]));
  const releasedPages: SnapshotPage[] = [];
  const releasedLinks: SnapshotLink[] = [];
  const acceptedWikiSpaceIds = new Set<bigint>();
  for (const wiki of publishedWikiBySpaceId.values()) {
    const wikiItems = input.releaseItems.filter((item) =>
      item.spaceId === wiki.spaceId
      && item.serverWikiId === wiki.id
      && item.releaseId === wiki.publishedReleaseId);
    if (wikiItems.length === 0) continue;
    const wikiProjection: Array<{ page: SnapshotPage; contentRaw: string }> = [];
    let validRelease = true;
    for (const item of wikiItems) {
      const revision = revisionByKey.get(`${item.pageId}:${item.revisionId}`);
      if (!revision) {
        validRelease = false;
        break;
      }
      wikiProjection.push({
        page: {
          id: item.pageId,
          namespaceId: item.namespaceId,
          spaceId: item.spaceId,
          localPath: item.localPath,
          slug: item.slug,
          title: item.title,
          displayTitle: item.displayTitle,
          currentRevisionId: item.revisionId,
          pageType: item.pageType,
          protectionLevel: item.protectionLevel,
          status: item.pageStatus,
          updatedAt: item.pageUpdatedAt,
        },
        contentRaw: revision.contentRaw,
      });
    }
    if (!validRelease) continue;
    for (const projected of wikiProjection) {
      releasedPages.push(projected.page);
      releasedLinks.push(...linksFromReleasedRevision(projected.page, projected.contentRaw, namespaceById));
    }
    acceptedWikiSpaceIds.add(wiki.spaceId);
  }
  const serverRouteBySpaceId = new Map<bigint, SnapshotServerRoute>();
  for (const spaceId of acceptedWikiSpaceIds) {
    const wiki = publishedWikiBySpaceId.get(spaceId);
    if (!wiki) continue;
    serverRouteBySpaceId.set(spaceId, {
      siteSlug: wiki.siteSlug ?? wiki.slug,
      contentRootSlug: wiki.slug,
    });
  }
  return {
    pages: [...ordinaryPages, ...releasedPages],
    links: [...ordinaryLinks, ...releasedLinks],
    serverRouteBySpaceId,
  };
}

function snapshotEnvelope(items: readonly SnapshotItem[]) {
  return { projectionVersion: WIKI_SPECIAL_SNAPSHOT_PROJECTION_VERSION, items };
}

function linksFromReleasedRevision(
  page: SnapshotPage,
  contentRaw: string,
  namespaceById: ReadonlyMap<number, string>,
): SnapshotLink[] {
  const namespaceCode = namespaceById.get(page.namespaceId) ?? 'main';
  const parsed = parseMarkup(contentRaw, { linkResolution: snapshotLinkResolutionContext(namespaceCode, page.localPath) });
  const links = new Map<string, SnapshotLink>();
  for (const target of parsed.links) {
    if (containsIncludePlaceholder(target)) continue;
    const resolved = parseLinkTarget(target);
    const targetNamespaceCode = namespaceCode === 'server'
      && resolved.namespace === 'main'
      && !target.includes(':')
      ? 'server'
      : resolved.namespace;
    const [contentRootSlug = ''] = slugifyTitle(page.localPath).split('/');
    const targetSlug = targetNamespaceCode === 'server' && resolved.namespace === 'main'
      ? slugifyTitle(`${contentRootSlug}/${resolved.title}`)
      : slugifyTitle(resolved.title);
    if (!targetSlug || targetSlug.length > 255 || targetNamespaceCode.length > 32) continue;
    const link: SnapshotLink = {
      sourcePageId: page.id,
      sourceRevisionId: page.currentRevisionId!,
      targetNamespaceCode,
      targetSlug,
      linkType: 'link',
    };
    links.set(`link:${targetNamespaceCode}:${targetSlug}`, link);
  }
  for (const category of parsed.categories) {
    if (containsIncludePlaceholder(category)) continue;
    const targetSlug = slugifyTitle(category);
    if (!targetSlug || targetSlug.length > 255) continue;
    links.set(`category:category:${targetSlug}`, {
      sourcePageId: page.id,
      sourceRevisionId: page.currentRevisionId!,
      targetNamespaceCode: 'category',
      targetSlug,
      linkType: 'category',
    });
  }
  return [...links.values()];
}

function snapshotLinkResolutionContext(namespaceCode: string, localPath: string): WikiLinkResolutionContext {
  const normalizedPath = localPath.trim().replace(/^\/+|\/+$/gu, '');
  if (namespaceCode === 'server') {
    const [, ...relativeSegments] = normalizedPath.split('/');
    return { currentDocumentPath: relativeSegments.join('/'), namespace: 'main' };
  }
  return {
    currentDocumentPath: normalizedPath,
    namespace: namespaceCode as NamespaceCode,
  };
}

function containsIncludePlaceholder(value: string): boolean {
  return /@[A-Za-z0-9가-힣_]+(?:=[^@\n]*)?@/u.test(value);
}

function snapshotRow(
  type: SnapshotType,
  namespaceCode: string,
  items: SnapshotItem[],
  pages: readonly SnapshotPage[],
  links: readonly SnapshotLink[],
  generation: string,
  generatedAt: Date
): SnapshotRow {
  if (items.length > MAX_SNAPSHOT_ITEMS) {
    throw new Error(`Wiki special snapshot ${type}:${namespaceCode} exceeds the safe item limit.`);
  }
  return {
    type,
    namespaceCode,
    generation,
    items,
    sourcePageCount: pages.length,
    sourceLinkCount: links.length,
    generatedAt
  };
}

function orphanedItems(
  pages: readonly SnapshotPage[],
  links: readonly SnapshotLink[],
  namespaceById: ReadonlyMap<number, string>,
  rootPageIds: ReadonlySet<bigint>,
  serverRouteBySpaceId: ReadonlyMap<bigint, SnapshotServerRoute>
): SnapshotItem[] {
  const incoming = new Set(links
    .filter((link) => link.linkType === 'link')
    .map((link) => `${link.targetNamespaceCode}:${link.targetSlug}`));
  return pages
    .filter((page) => !rootPageIds.has(page.id) && !incoming.has(`${namespaceById.get(page.namespaceId) ?? 'main'}:${page.slug}`))
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || compareBigInt(right.id, left.id))
    .map((page) => pageItem(page, namespaceById.get(page.namespaceId) ?? 'main', serverRouteBySpaceId));
}

function wantedItems(
  links: readonly SnapshotLink[],
  pageById: ReadonlyMap<bigint, SnapshotPage>,
  existingPageKeys: ReadonlySet<string>,
  serverRouteBySpaceId: ReadonlyMap<bigint, SnapshotServerRoute>
): SnapshotItem[] {
  const counts = new Map<string, {
    namespace: string;
    slug: string;
    count: number;
    sourcePage: SnapshotPage;
    sourceCounts: Map<bigint, number>;
  }>();
  for (const link of links) {
    if (link.linkType !== 'link') continue;
    const sourcePage = pageById.get(link.sourcePageId);
    if (!sourcePage) continue;
    const key = pageKey(link.targetNamespaceCode, link.targetSlug, sourcePage.spaceId);
    if (existingPageKeys.has(key)) continue;
    const current = counts.get(key);
    if (current) {
      current.count += 1;
      current.sourceCounts.set(sourcePage.id, (current.sourceCounts.get(sourcePage.id) ?? 0) + 1);
    } else {
      counts.set(key, {
        namespace: link.targetNamespaceCode,
        slug: link.targetSlug,
        count: 1,
        sourcePage,
        sourceCounts: new Map([[sourcePage.id, 1]])
      });
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0], 'ko'))
    .map(([key, target]) => ({
      id: `wanted:${key}`,
      pageId: null,
      namespace: target.namespace,
      title: target.slug,
      displayTitle: (target.slug.split('/').at(-1) ?? target.slug).replace(/_/g, ' '),
      routePath: targetRoutePath(target.namespace, target.slug, target.sourcePage, serverRouteBySpaceId),
      value: target.count,
      updatedAt: null,
      ...sourceContributionMetadata(target.sourceCounts)
    }));
}

function categoryItems(links: readonly SnapshotLink[]): SnapshotItem[] {
  const counts = new Map<string, { count: number; sourceCounts: Map<bigint, number> }>();
  for (const link of links) {
    if (link.linkType !== 'category' || link.targetNamespaceCode !== 'category') continue;
    const current = counts.get(link.targetSlug);
    if (current) {
      current.count += 1;
      current.sourceCounts.set(link.sourcePageId, (current.sourceCounts.get(link.sourcePageId) ?? 0) + 1);
    } else {
      counts.set(link.targetSlug, { count: 1, sourceCounts: new Map([[link.sourcePageId, 1]]) });
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0], 'ko'))
    .map(([slug, aggregate]) => ({
      id: `category:${slug}`,
      pageId: null,
      namespace: 'category',
      title: slug,
      displayTitle: slug.replace(/_/g, ' '),
      routePath: wikiUrl('category', slug),
      value: aggregate.count,
      updatedAt: null,
      ...sourceContributionMetadata(aggregate.sourceCounts)
    }));
}

function sourceContributionMetadata(sourceCounts: ReadonlyMap<bigint, number>): Pick<
  SnapshotItem,
  'sourceContributions' | 'sourceContributionsComplete'
> {
  const contributions = [...sourceCounts.entries()]
    .sort((left, right) => compareBigInt(left[0], right[0]));
  if (contributions.length > MAX_SNAPSHOT_SOURCE_CONTRIBUTIONS) {
    throw new Error('Wiki special snapshot contribution list exceeds the safe item limit.');
  }
  return {
    sourceContributions: contributions
      .map(([pageId, count]) => ({ pageId: pageId.toString(), count })),
    sourceContributionsComplete: true
  };
}

function orphanedCategoryItems(
  pages: readonly SnapshotPage[],
  links: readonly SnapshotLink[],
  serverRouteBySpaceId: ReadonlyMap<bigint, SnapshotServerRoute>
): SnapshotItem[] {
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const pageBySlug = new Map(pages.map((page) => [page.slug, page]));
  const childrenByParentSlug = new Map<string, Set<string>>();
  for (const link of links) {
    if (link.linkType !== 'category' || link.targetNamespaceCode !== 'category') continue;
    const source = pageById.get(link.sourcePageId);
    if (!source) continue;
    const children = childrenByParentSlug.get(link.targetSlug) ?? new Set<string>();
    children.add(source.slug);
    childrenByParentSlug.set(link.targetSlug, children);
  }
  const rootSlug = slugifyTitle('분류');
  const reachable = new Set<string>();
  const queue = pageBySlug.has(rootSlug) ? [rootSlug] : [];
  while (queue.length > 0) {
    const slug = queue.shift();
    if (!slug || reachable.has(slug)) continue;
    reachable.add(slug);
    for (const child of childrenByParentSlug.get(slug) ?? []) {
      if (pageBySlug.has(child) && !reachable.has(child)) queue.push(child);
    }
  }
  return pages
    .filter((page) => page.slug !== rootSlug && !reachable.has(page.slug))
    .sort((left, right) => left.displayTitle.localeCompare(right.displayTitle, 'ko'))
    .map((page) => pageItem(page, 'category', serverRouteBySpaceId));
}

function pageItem(
  page: SnapshotPage,
  namespace: string,
  serverRouteBySpaceId: ReadonlyMap<bigint, SnapshotServerRoute>
): SnapshotItem {
  return {
    id: `page:${page.id.toString()}`,
    pageId: page.id.toString(),
    namespace,
    title: page.title,
    displayTitle: page.displayTitle,
    routePath: pageRoutePath(page, namespace, serverRouteBySpaceId),
    value: null,
    updatedAt: page.updatedAt.toISOString()
  };
}

function pageKey(namespace: string, slug: string, spaceId: bigint): string {
  return `${namespace}:${slug}${namespace === 'server' ? `:${spaceId.toString()}` : ''}`;
}

function pageRoutePath(
  page: SnapshotPage,
  namespace: string,
  serverRouteBySpaceId: ReadonlyMap<bigint, SnapshotServerRoute>
): string {
  if (namespace === 'server') {
    const route = serverRouteBySpaceId.get(page.spaceId);
    if (route) return canonicalServerPath(route, page.title);
  }
  return wikiUrl(namespace as NamespaceCode, page.title);
}

function targetRoutePath(
  namespace: string,
  slug: string,
  sourcePage: SnapshotPage,
  serverRouteBySpaceId: ReadonlyMap<bigint, SnapshotServerRoute>
): string {
  if (namespace === 'server') {
    const route = serverRouteBySpaceId.get(sourcePage.spaceId);
    if (route) return canonicalServerPath(route, slug);
  }
  return wikiUrl(namespace as NamespaceCode, slug);
}

function canonicalServerPath(route: SnapshotServerRoute, localPath: string): string {
  const normalizedSiteSlug = slugifyTitle(route.siteSlug);
  const normalizedSlug = slugifyTitle(route.contentRootSlug);
  const normalizedPath = slugifyTitle(localPath);
  const relative = normalizedPath === normalizedSlug
    ? ''
    : normalizedPath.startsWith(`${normalizedSlug}/`)
      ? normalizedPath.slice(normalizedSlug.length + 1)
      : normalizedPath;
  const encode = (value: string) => value.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return relative
    ? `/serverWiki/${encode(normalizedSiteSlug)}/${encode(relative)}`
    : `/serverWiki/${encode(normalizedSiteSlug)}`;
}

function indexAclRules(rules: readonly SnapshotAclRule[]): ReadonlyMap<string, readonly SnapshotAclRule[]> {
  const indexed = new Map<string, SnapshotAclRule[]>();
  for (const rule of rules) {
    const key = aclTargetKey(rule.targetType, rule.targetId);
    indexed.set(key, [...(indexed.get(key) ?? []), rule]);
  }
  for (const values of indexed.values()) values.sort((left, right) => left.sortOrder - right.sortOrder);
  return indexed;
}

function genericAnonymousReadAllowed(
  page: SnapshotPage,
  rulesByTarget: ReadonlyMap<string, readonly SnapshotAclRule[]>
): boolean {
  const scopes: Array<[string, bigint | null]> = [
    ['page', page.id],
    ['space', page.spaceId],
    ['namespace', BigInt(page.namespaceId)],
    ['site', null]
  ];
  for (const [targetType, targetId] of scopes) {
    for (const rule of rulesByTarget.get(aclTargetKey(targetType, targetId)) ?? []) {
      const subject = rule.subjectValue.replace(new RegExp(`^${rule.subjectType}:`), '');
      if (rule.subjectType !== 'perm' || (subject !== 'any' && subject !== 'guest')) continue;
      return rule.effect === 'allow';
    }
  }
  return true;
}

function aclTargetKey(targetType: string, targetId: bigint | null): string {
  return `${targetType}:${targetId?.toString() ?? ''}`;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
