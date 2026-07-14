import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { slugifyTitle, wikiUrl, type NamespaceCode } from '@minewiki/wiki-core';

const SNAPSHOT_ITEM_LIMIT = 500;
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

export function buildWikiSpecialSnapshotRows(input: {
  readonly pages: readonly SnapshotPage[];
  readonly links: readonly SnapshotLink[];
  readonly namespaces: ReadonlyArray<{ readonly id: number; readonly code: string }>;
  readonly activeSpaceIds: ReadonlySet<bigint>;
  readonly rootPageIds: ReadonlySet<bigint>;
  readonly serverSlugBySpaceId: ReadonlyMap<bigint, string>;
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
      input.serverSlugBySpaceId
    ), scopePages, scopeLinks, generation, generatedAt));
    rows.push(snapshotRow('wanted', namespaceCode, wantedItems(
      scopeLinks,
      visiblePageById,
      existingPageKeys,
      input.serverSlugBySpaceId
    ), scopePages, scopeLinks, generation, generatedAt));
    rows.push(snapshotRow('categories', namespaceCode, categoryItems(scopeLinks), scopePages, scopeLinks, generation, generatedAt));
    if (!namespaceCode || namespaceCode === 'category') {
      const categoryPages = scopePages.filter((page) => namespaceById.get(page.namespaceId) === 'category');
      const categoryPageIds = new Set(categoryPages.map((page) => page.id));
      const categoryLinks = scopeLinks.filter((link) => categoryPageIds.has(link.sourcePageId));
      rows.push(snapshotRow('orphaned_categories', namespaceCode, orphanedCategoryItems(
        categoryPages,
        categoryLinks,
        input.serverSlugBySpaceId
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
      where: { status: { not: 'disabled' } },
      select: { spaceId: true, slug: true }
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
  const generation = randomUUID();
  const rows = buildWikiSpecialSnapshotRows({
    pages,
    links,
    namespaces,
    activeSpaceIds: new Set(spaces.map((space) => space.id)),
    rootPageIds: new Set(spaces.flatMap((space) => space.rootPageId ? [space.rootPageId] : [])),
    serverSlugBySpaceId: new Map(serverWikis.map((wiki) => [wiki.spaceId, wiki.slug])),
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
      items: row.items as unknown as Prisma.InputJsonValue,
      sourcePageCount: row.sourcePageCount,
      sourceLinkCount: row.sourceLinkCount,
      generatedAt: row.generatedAt
    },
    update: {
      generation: row.generation,
      items: row.items as unknown as Prisma.InputJsonValue,
      sourcePageCount: row.sourcePageCount,
      sourceLinkCount: row.sourceLinkCount,
      generatedAt: row.generatedAt
    }
  })));
  return { generation, rows: rows.length, sourcePages: pages.length, sourceLinks: links.length };
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
  return {
    type,
    namespaceCode,
    generation,
    items: items.slice(0, SNAPSHOT_ITEM_LIMIT),
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
  serverSlugBySpaceId: ReadonlyMap<bigint, string>
): SnapshotItem[] {
  const incoming = new Set(links
    .filter((link) => link.linkType === 'link')
    .map((link) => `${link.targetNamespaceCode}:${link.targetSlug}`));
  return pages
    .filter((page) => !rootPageIds.has(page.id) && !incoming.has(`${namespaceById.get(page.namespaceId) ?? 'main'}:${page.slug}`))
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || compareBigInt(right.id, left.id))
    .map((page) => pageItem(page, namespaceById.get(page.namespaceId) ?? 'main', serverSlugBySpaceId));
}

function wantedItems(
  links: readonly SnapshotLink[],
  pageById: ReadonlyMap<bigint, SnapshotPage>,
  existingPageKeys: ReadonlySet<string>,
  serverSlugBySpaceId: ReadonlyMap<bigint, string>
): SnapshotItem[] {
  const counts = new Map<string, { namespace: string; slug: string; count: number; sourcePage: SnapshotPage }>();
  for (const link of links) {
    if (link.linkType !== 'link') continue;
    const sourcePage = pageById.get(link.sourcePageId);
    if (!sourcePage) continue;
    const key = pageKey(link.targetNamespaceCode, link.targetSlug, sourcePage.spaceId);
    if (existingPageKeys.has(key)) continue;
    const current = counts.get(key);
    counts.set(key, {
      namespace: link.targetNamespaceCode,
      slug: link.targetSlug,
      count: (current?.count ?? 0) + 1,
      sourcePage
    });
  }
  return [...counts.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0], 'ko'))
    .map(([key, target]) => ({
      id: `wanted:${key}`,
      pageId: null,
      namespace: target.namespace,
      title: target.slug,
      displayTitle: (target.slug.split('/').at(-1) ?? target.slug).replace(/_/g, ' '),
      routePath: targetRoutePath(target.namespace, target.slug, target.sourcePage, serverSlugBySpaceId),
      value: target.count,
      updatedAt: null
    }));
}

function categoryItems(links: readonly SnapshotLink[]): SnapshotItem[] {
  const counts = new Map<string, number>();
  for (const link of links) {
    if (link.linkType !== 'category' || link.targetNamespaceCode !== 'category') continue;
    counts.set(link.targetSlug, (counts.get(link.targetSlug) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'ko'))
    .map(([slug, count]) => ({
      id: `category:${slug}`,
      pageId: null,
      namespace: 'category',
      title: slug,
      displayTitle: slug.replace(/_/g, ' '),
      routePath: wikiUrl('category', slug),
      value: count,
      updatedAt: null
    }));
}

function orphanedCategoryItems(
  pages: readonly SnapshotPage[],
  links: readonly SnapshotLink[],
  serverSlugBySpaceId: ReadonlyMap<bigint, string>
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
    .map((page) => pageItem(page, 'category', serverSlugBySpaceId));
}

function pageItem(
  page: SnapshotPage,
  namespace: string,
  serverSlugBySpaceId: ReadonlyMap<bigint, string>
): SnapshotItem {
  return {
    id: `page:${page.id.toString()}`,
    pageId: page.id.toString(),
    namespace,
    title: page.title,
    displayTitle: page.displayTitle,
    routePath: pageRoutePath(page, namespace, serverSlugBySpaceId),
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
  serverSlugBySpaceId: ReadonlyMap<bigint, string>
): string {
  if (namespace === 'server') {
    const serverSlug = serverSlugBySpaceId.get(page.spaceId);
    if (serverSlug) return canonicalServerPath(serverSlug, page.localPath);
  }
  return wikiUrl(namespace as NamespaceCode, page.title);
}

function targetRoutePath(
  namespace: string,
  slug: string,
  sourcePage: SnapshotPage,
  serverSlugBySpaceId: ReadonlyMap<bigint, string>
): string {
  if (namespace === 'server') {
    const serverSlug = serverSlugBySpaceId.get(sourcePage.spaceId);
    if (serverSlug) return canonicalServerPath(serverSlug, slug);
  }
  return wikiUrl(namespace as NamespaceCode, slug);
}

function canonicalServerPath(serverSlug: string, localPath: string): string {
  const normalizedSlug = slugifyTitle(serverSlug);
  const normalizedPath = slugifyTitle(localPath);
  const relative = normalizedPath === normalizedSlug
    ? ''
    : normalizedPath.startsWith(`${normalizedSlug}/`)
      ? normalizedPath.slice(normalizedSlug.length + 1)
      : normalizedPath;
  const encode = (value: string) => value.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return relative ? `/server/${encode(normalizedSlug)}/${encode(relative)}` : `/server/${encode(normalizedSlug)}`;
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
