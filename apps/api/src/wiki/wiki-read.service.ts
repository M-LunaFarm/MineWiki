import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { WikiPage } from '@prisma/client';
import {
  type AstNode,
  buildWikiSearchBooleanQuery,
  parseLinkTarget,
  parseMarkup,
  renderDocument,
  resolveWikiPath,
  slugifyTitle,
  wikiLinkKey,
  wikiUrl,
  WIKI_RENDERER_VERSION
} from '@minewiki/wiki-core';
import { PrismaService } from '../common/prisma.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiLinkIndexService } from './wiki-link-index.service';
import { WikiIncludeService } from './wiki-include.service';
import { buildCanonicalServerWikiPath, WikiRoutePathResolver, type WikiRoutePathBatch } from './wiki-route-path.resolver';

export interface WikiPageResponse {
  readonly id: string;
  readonly namespace: string;
  readonly spaceId: string;
  readonly slug: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly pageType: string;
  readonly protectionLevel: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly revision: {
    readonly id: string;
    readonly revisionNo: number;
    readonly contentHash: string;
    readonly createdAt: string;
    readonly createdBy: string | null;
  };
  readonly html: string;
  readonly links: string[];
  readonly categories: string[];
  readonly headings: ReadonlyArray<{
    readonly level: number;
    readonly title: string;
    readonly anchor: string;
  }>;
  readonly redirectTarget: string | null;
  readonly redirectedFrom?: {
    readonly namespace: string;
    readonly title: string;
    readonly path: string;
  } | null;
  readonly serverDirectoryPath?: string | null;
  readonly serverWiki?: {
    readonly name: string;
    readonly slug: string;
    readonly host: string | null;
    readonly port: number | null;
    readonly edition: string;
    readonly supportedVersions: string | null;
    readonly genres: string | null;
    readonly isOnline: boolean | null;
    readonly playersOnline: number | null;
    readonly playersMax: number | null;
    readonly layout: 'docs' | 'handbook' | 'brand';
    readonly navigation: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly path: string;
      readonly current: boolean;
      readonly depth: number;
      readonly hasChildren: boolean;
    }>;
  } | null;
}

export interface WikiRevisionSummary {
  readonly id: string;
  readonly revisionNo: number;
  readonly editSummary: string | null;
  readonly isMinor: boolean;
  readonly createdBy: string | null;
  readonly createdByName: string | null;
  readonly createdAt: string;
  readonly contentHash: string;
  readonly contentSize: number;
}

export interface WikiRecentChangeSummary {
  readonly id: string;
  readonly pageId: string | null;
  readonly revisionId: string | null;
  readonly actorId: string | null;
  readonly changeType: string;
  readonly title: string;
  readonly namespaceCode: string;
  readonly routePath: string;
  readonly summary: string | null;
  readonly isMinor: boolean;
  readonly createdAt: string;
}

export interface WikiRecentChangeListResponse {
  readonly items: WikiRecentChangeSummary[];
  readonly nextCursor: string | null;
}

export interface WikiSearchResult {
  readonly pageId: string;
  readonly namespace: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly routePath: string;
  readonly snippet: string;
  readonly updatedAt: string;
}

export interface WikiSearchResponse {
  readonly items: WikiSearchResult[];
  readonly nextCursor: string | null;
}

export interface WikiSearchSuggestionResponse {
  readonly items: WikiSearchResult[];
  readonly exactMatch: WikiSearchResult | null;
}

export interface WikiBacklinkItem {
  readonly id: string;
  readonly sourcePageId: string;
  readonly sourceRevisionId: string;
  readonly namespace: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly routePath: string;
  readonly linkType: string;
  readonly updatedAt: string;
}

export interface WikiBacklinkResponse {
  readonly items: WikiBacklinkItem[];
  readonly nextCursor: string | null;
}

export interface WikiContributionItem {
  readonly id: string;
  readonly kind: 'document' | 'discussion' | 'edit_request' | 'review';
  readonly pageId: string;
  readonly revisionId: string | null;
  readonly changeType: string;
  readonly title: string;
  readonly namespace: string;
  readonly routePath: string;
  readonly href: string;
  readonly summary: string | null;
  readonly isMinor: boolean;
  readonly status: string | null;
  readonly createdAt: string;
}

export interface WikiContributionResponse {
  readonly activity: 'edits' | 'discussions' | 'edit-requests' | 'reviews';
  readonly profile: {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
    readonly status: string;
  };
  readonly items: WikiContributionItem[];
  readonly nextCursor: string | null;
}

export interface WikiRevisionListResponse {
  readonly items: WikiRevisionSummary[];
  readonly nextCursor: string | null;
}

export interface WikiDeletedPageSummary {
  readonly id: string;
  readonly namespace: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly spaceId: string;
  readonly updatedAt: string;
}

export type WikiSpecialDocumentType =
  | 'random'
  | 'orphaned'
  | 'orphaned_categories'
  | 'wanted'
  | 'categories'
  | 'uncategorized'
  | 'old'
  | 'long'
  | 'short';

export interface WikiSpecialDocumentItem {
  readonly id: string;
  readonly pageId: string | null;
  readonly namespace: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly routePath: string;
  readonly value: number | null;
  readonly updatedAt: string | null;
}

export interface WikiSpecialDocumentResponse {
  readonly type: WikiSpecialDocumentType;
  readonly items: WikiSpecialDocumentItem[];
  readonly generation?: string | null;
  readonly generatedAt?: string | null;
  readonly isRebuilding?: boolean;
  readonly isStale?: boolean;
}

export interface WikiCategoryResponse {
  readonly category: string;
  readonly document: {
    readonly pageId: string;
    readonly routePath: string;
  } | null;
  readonly parents: ReadonlyArray<{
    readonly category: string;
    readonly routePath: string;
  }>;
  readonly subcategories: ReadonlyArray<{
    readonly pageId: string;
    readonly category: string;
    readonly displayTitle: string;
    readonly routePath: string;
  }>;
  readonly isRoot: boolean;
  readonly isOrphan: boolean;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly pageId: string;
    readonly namespace: string;
    readonly title: string;
    readonly displayTitle: string;
    readonly routePath: string;
    readonly updatedAt: string;
  }>;
  readonly nextCursor: string | null;
}

export interface WikiDocumentTemplateSummary {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly scope: string;
  readonly targetArea: string;
  readonly defaultCategory: string | null;
  readonly contentRaw: string;
}

export interface WikiBlameResponse {
  readonly pageId: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly revisionCount: number;
  readonly truncatedHistory: boolean;
  readonly lineCount: number;
  readonly truncatedLines: boolean;
  readonly lines: ReadonlyArray<{
    readonly lineNo: number;
    readonly content: string;
    readonly revisionId: string;
    readonly revisionNo: number;
    readonly createdBy: string | null;
    readonly createdByName: string;
    readonly createdAt: string;
  }>;
}

@Injectable()
export class WikiReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiPermissions: WikiPermissionService,
    @Optional() private readonly wikiLinks?: WikiLinkIndexService,
    @Optional() private readonly wikiIncludes?: WikiIncludeService,
    @Optional() private readonly injectedRoutePaths?: WikiRoutePathResolver
  ) {}

  private get routePaths(): WikiRoutePathResolver {
    return this.injectedRoutePaths ?? new WikiRoutePathResolver(this.prisma);
  }

  async getPage(
    namespaceCode: string,
    title: string,
    accountId?: string | null,
    options: { readonly followRedirects?: boolean } = {}
  ): Promise<WikiPageResponse> {
    return this.getPageInternal(namespaceCode, title, accountId ?? null, {
      followRedirects: options.followRedirects !== false,
      redirectTrail: []
    });
  }

  private async getPageInternal(
    namespaceCode: string,
    title: string,
    accountId: string | null,
    options: {
      readonly followRedirects: boolean;
      readonly redirectTrail: readonly string[];
    }
  ): Promise<WikiPageResponse> {
    const normalizedNamespace = namespaceCode.trim() || 'main';
    const normalizedTitle = title.trim() || '대문';
    const pageKey = `${normalizedNamespace}:${slugifyTitle(normalizedTitle)}`;
    if (options.redirectTrail.includes(pageKey)) {
      throw new BadRequestException('Wiki redirect loop detected.');
    }
    if (options.redirectTrail.length >= 5) {
      throw new BadRequestException('Wiki redirect depth exceeded.');
    }
    const namespace = await this.prisma.wikiNamespace.findUnique({
      where: { code: normalizedNamespace }
    });
    if (!namespace) {
      throw new NotFoundException('Wiki namespace not found.');
    }

    const page = await this.prisma.wikiPage.findUnique({
      where: {
        namespaceId_slug: {
          namespaceId: namespace.id,
          slug: slugifyTitle(normalizedTitle)
        }
      }
    });
    if (!page) {
      throw new NotFoundException('Wiki page not found.');
    }
    return this.renderPage(namespace.code, page, accountId, options);
  }

  getPageByPath(
    path: string,
    accountId?: string | null,
    options: { readonly followRedirects?: boolean } = {}
  ): Promise<WikiPageResponse> {
    const resolved = resolveWikiPath(path);
    return this.getPage(resolved.namespace, resolved.title, accountId ?? null, options);
  }

  async getRevisions(pageId: string, accountId?: string | null, cursor?: string, requestedLimit: string | number = 50): Promise<WikiRevisionListResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: parsedPageId } });
    if (!page) {
      throw new NotFoundException('Wiki page not found.');
    }
    await this.wikiPermissions.assertCanReadPage({
      accountId: accountId ?? null,
      page
    });
    await this.wikiPermissions.assertCanUsePageAction({
      accountId: accountId ?? null,
      action: 'history',
      page
    });
    const limit = Math.min(Math.max(Number(requestedLimit) || 50, 1), 100);
    const cursorRevisionNo = cursor ? this.parsePositiveInt(cursor, 'cursor') : null;
    const revisions = await this.prisma.wikiPageRevision.findMany({
      where: {
        pageId: parsedPageId,
        visibility: 'public',
        ...(cursorRevisionNo ? { revisionNo: { lt: cursorRevisionNo } } : {})
      },
      orderBy: [{ revisionNo: 'desc' }],
      take: limit + 1
    });
    const hasMore = revisions.length > limit;
    const pageRows = revisions.slice(0, limit);
    const profileIds = [...new Set(pageRows.flatMap((revision) => revision.createdBy ? [revision.createdBy] : []))];
    const profiles = profileIds.length > 0
      ? await this.prisma.wikiProfile.findMany({
          where: { id: { in: profileIds } },
          select: { id: true, displayName: true }
        })
      : [];
    const profileById = new Map(profiles.map((profile) => [profile.id, profile.displayName]));
    const items = pageRows.map((revision) => ({
      id: revision.id.toString(),
      revisionNo: revision.revisionNo,
      editSummary: revision.editSummary,
      isMinor: revision.isMinor,
      createdBy: revision.createdBy?.toString() ?? null,
      createdByName: revision.createdBy ? profileById.get(revision.createdBy) ?? null : null,
      createdAt: revision.createdAt.toISOString(),
      contentHash: revision.contentHash,
      contentSize: revision.contentSize
    }));
    return { items, nextCursor: hasMore ? pageRows.at(-1)?.revisionNo.toString() ?? null : null };
  }

  async getRecent(input: {
    readonly accountId?: string | null;
    readonly cursor?: string;
    readonly limit?: string | number;
    readonly changeType?: string;
    readonly namespace?: string;
    readonly minor?: string;
  } = {}): Promise<WikiRecentChangeListResponse> {
    const limit = Math.min(Math.max(Number(input.limit ?? 30) || 30, 1), 100);
    const cursor = input.cursor ? this.parseBigIntId(input.cursor, 'cursor') : null;
    const changeType = this.parseRecentFilter(input.changeType, 'changeType');
    const namespace = this.parseRecentFilter(input.namespace, 'namespace');
    const isMinor = input.minor === 'true' ? true : input.minor === 'false' ? false : undefined;
    if (input.minor && isMinor === undefined) throw new BadRequestException('minor must be true or false.');
    const scanLimit = Math.min(limit * 4 + 1, 401);
    const changes = await this.prisma.wikiRecentChange.findMany({
      where: {
        ...(cursor ? { id: { lt: cursor } } : {}),
        ...(changeType ? { changeType } : {}),
        ...(namespace ? { namespaceCode: namespace } : {}),
        ...(isMinor === undefined ? {} : { isMinor })
      },
      orderBy: [{ id: 'desc' }],
      take: scanLimit
    });
    const pageIds = [...new Set(changes.flatMap((change) => change.pageId ? [change.pageId] : []))];
    const pages = pageIds.length > 0 ? await this.prisma.wikiPage.findMany({ where: { id: { in: pageIds } } }) : [];
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const knownNamespaces = new Map<number, string>();
    for (const change of changes) {
      const page = change.pageId ? pageById.get(change.pageId) : null;
      if (page) knownNamespaces.set(page.namespaceId, change.namespaceCode);
    }
    const routePaths = await this.routePaths.preload(pages, knownNamespaces);
    const readableByPageId = new Map<bigint, boolean>();
    const visible: WikiRecentChangeSummary[] = [];
    let lastScannedId: bigint | null = null;
    for (const change of changes) {
      lastScannedId = change.id;
      if (change.pageId) {
        let readable = readableByPageId.get(change.pageId);
        if (readable === undefined) {
          try {
            await this.wikiPermissions.assertCanReadPage({ accountId: input.accountId ?? null, page: pageById.get(change.pageId) ?? null });
            readable = true;
          } catch {
            readable = false;
          }
          readableByPageId.set(change.pageId, readable);
        }
        if (!readable) continue;
      }
      visible.push({
        id: change.id.toString(),
        pageId: change.pageId?.toString() ?? null,
        revisionId: change.revisionId?.toString() ?? null,
        actorId: change.actorId?.toString() ?? null,
        changeType: change.changeType,
        title: change.title,
        namespaceCode: change.namespaceCode,
        routePath: change.pageId && pageById.has(change.pageId)
          ? routePaths.routePath(pageById.get(change.pageId)!, change.namespaceCode)
          : wikiUrl(change.namespaceCode as Parameters<typeof wikiUrl>[0], change.title),
        summary: change.summary,
        isMinor: change.isMinor,
        createdAt: change.createdAt.toISOString()
      });
      if (visible.length >= limit) break;
    }
    const mayHaveMore = changes.length > 0 && (visible.length >= limit || changes.length >= scanLimit);
    return { items: visible, nextCursor: mayHaveMore ? lastScannedId?.toString() ?? null : null };
  }

  async getBacklinks(input: {
    readonly pageId: string;
    readonly accountId?: string | null;
    readonly cursor?: string;
    readonly limit?: string | number;
  }): Promise<WikiBacklinkResponse> {
    const pageId = this.parseBigIntId(input.pageId, 'pageId');
    const target = await this.prisma.wikiPage.findUnique({ where: { id: pageId } });
    if (!target) throw new NotFoundException('Wiki page not found.');
    await this.wikiPermissions.assertCanReadPage({ accountId: input.accountId ?? null, page: target });
    const namespace = await this.prisma.wikiNamespace.findUnique({ where: { id: target.namespaceId } });
    if (!namespace) throw new NotFoundException('Wiki namespace not found.');
    const limit = Math.min(Math.max(Number(input.limit ?? 30) || 30, 1), 100);
    const cursor = input.cursor ? this.parseBigIntId(input.cursor, 'cursor') : null;
    const links = await this.prisma.wikiPageLink.findMany({
      where: {
        targetNamespaceCode: namespace.code,
        targetSlug: target.slug,
        ...(cursor ? { id: { lt: cursor } } : {})
      },
      orderBy: [{ id: 'desc' }],
      take: Math.min(limit * 4 + 1, 401)
    });
    const pageIds = [...new Set(links.map((link) => link.sourcePageId))];
    const pages = pageIds.length > 0
      ? await this.prisma.wikiPage.findMany({ where: { id: { in: pageIds } } })
      : [];
    const namespaceIds = [...new Set(pages.map((page) => page.namespaceId))];
    const namespaces = namespaceIds.length > 0
      ? await this.prisma.wikiNamespace.findMany({ where: { id: { in: namespaceIds } } })
      : [];
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const namespaceById = new Map(namespaces.map((item) => [item.id, item.code]));
    const routePaths = await this.routePaths.preload(pages, namespaceById);
    const items: WikiBacklinkItem[] = [];
    let lastScannedId: bigint | null = null;
    for (const link of links) {
      lastScannedId = link.id;
      const source = pageById.get(link.sourcePageId);
      if (!source || source.currentRevisionId !== link.sourceRevisionId) continue;
      try {
        await this.wikiPermissions.assertCanReadPage({ accountId: input.accountId ?? null, page: source });
      } catch {
        continue;
      }
      const sourceNamespace = namespaceById.get(source.namespaceId) ?? 'main';
      items.push({
        id: link.id.toString(),
        sourcePageId: source.id.toString(),
        sourceRevisionId: link.sourceRevisionId.toString(),
        namespace: sourceNamespace,
        title: source.title,
        displayTitle: source.displayTitle,
        routePath: routePaths.routePath(source, sourceNamespace),
        linkType: link.linkType,
        updatedAt: source.updatedAt.toISOString()
      });
      if (items.length >= limit) break;
    }
    const mayHaveMore = links.length > 0 && (items.length >= limit || links.length >= Math.min(limit * 4 + 1, 401));
    return {
      items,
      nextCursor: mayHaveMore ? lastScannedId?.toString() ?? null : null
    };
  }

  async getCategoryMembers(input: {
    readonly category: string;
    readonly accountId?: string | null;
    readonly namespace?: string;
    readonly cursor?: string;
    readonly limit?: string | number;
  }): Promise<WikiCategoryResponse> {
    const category = input.category.trim().replace(/_/g, ' ');
    const categorySlug = slugifyTitle(category);
    if (!categorySlug) throw new BadRequestException('category is required.');
    const categoryNamespace = await this.prisma.wikiNamespace.findUnique({
      where: { code: 'category' },
      select: { id: true, code: true }
    });
    const namespace = input.namespace?.trim()
      ? await this.prisma.wikiNamespace.findUnique({ where: { code: input.namespace.trim() }, select: { id: true, code: true } })
      : null;
    const emptyHierarchy = {
      document: null,
      parents: [],
      subcategories: [],
      isRoot: categorySlug === slugifyTitle('분류'),
      isOrphan: false
    };
    if (input.namespace?.trim() && !namespace) return { category, ...emptyHierarchy, items: [], nextCursor: null };
    const categoryPage = categoryNamespace
      ? await this.prisma.wikiPage.findUnique({
          where: { namespaceId_slug: { namespaceId: categoryNamespace.id, slug: categorySlug } }
        })
      : null;
    let readableCategoryPage = null as typeof categoryPage;
    if (categoryPage && categoryPage.status !== 'deleted' && categoryPage.currentRevisionId) {
      try {
        await this.wikiPermissions.assertCanReadPage({ accountId: input.accountId ?? null, page: categoryPage });
        readableCategoryPage = categoryPage;
      } catch {
        readableCategoryPage = null;
      }
    }
    const parentLinks = readableCategoryPage
      ? await this.prisma.wikiPageLink.findMany({
          where: {
            sourcePageId: readableCategoryPage.id,
            sourceRevisionId: readableCategoryPage.currentRevisionId ?? undefined,
            targetNamespaceCode: 'category',
            linkType: 'category'
          },
          orderBy: [{ targetSlug: 'asc' }],
          take: 100
        })
      : [];
    const parents = parentLinks.map((link) => ({
      category: categoryTitleFromSlug(link.targetSlug),
      routePath: wikiUrl('category', link.targetSlug)
    }));
    const childLinks = categoryNamespace
      ? await this.prisma.wikiPageLink.findMany({
          where: {
            targetNamespaceCode: 'category',
            targetSlug: categorySlug,
            linkType: 'category'
          },
          orderBy: [{ id: 'desc' }],
          take: 501
        })
      : [];
    const childPageIds = [...new Set(childLinks.map((link) => link.sourcePageId))];
    const childPages = categoryNamespace && childPageIds.length > 0
      ? await this.prisma.wikiPage.findMany({
          where: {
            id: { in: childPageIds },
            namespaceId: categoryNamespace.id,
            status: { in: ['normal', 'active', 'published'] },
            pageType: { not: 'redirect' }
          }
        })
      : [];
    const childLinkByPageId = new Map(childLinks.map((link) => [link.sourcePageId, link]));
    const subcategories: WikiCategoryResponse['subcategories'][number][] = [];
    for (const childPage of childPages) {
      const link = childLinkByPageId.get(childPage.id);
      if (!link || childPage.currentRevisionId !== link.sourceRevisionId) continue;
      try {
        await this.wikiPermissions.assertCanReadPage({ accountId: input.accountId ?? null, page: childPage });
      } catch {
        continue;
      }
      subcategories.push({
        pageId: childPage.id.toString(),
        category: childPage.title,
        displayTitle: childPage.displayTitle,
        routePath: wikiUrl('category', childPage.title)
      });
    }
    subcategories.sort((left, right) => left.displayTitle.localeCompare(right.displayTitle, 'ko'));
    const isRoot = categorySlug === slugifyTitle('분류');
    const reachesRoot = isRoot || (readableCategoryPage && categoryNamespace
      ? await this.categoryParentsReachRoot(parentLinks.map((link) => link.targetSlug), categoryNamespace.id, input.accountId ?? null)
      : false);
    const limit = Math.min(Math.max(Number(input.limit ?? 30) || 30, 1), 100);
    const cursor = input.cursor ? this.parseBigIntId(input.cursor, 'cursor') : null;
    const scanLimit = Math.min(limit * 4 + 1, 401);
    const links = await this.prisma.wikiPageLink.findMany({
      where: {
        targetNamespaceCode: 'category',
        targetSlug: categorySlug,
        linkType: 'category',
        ...(cursor ? { id: { lt: cursor } } : {})
      },
      orderBy: [{ id: 'desc' }],
      take: scanLimit
    });
    const pageIds = [...new Set(links.map((link) => link.sourcePageId))];
    const pages = pageIds.length > 0
      ? await this.prisma.wikiPage.findMany({
          where: {
            id: { in: pageIds },
            ...(namespace
              ? { namespaceId: namespace.id }
              : categoryNamespace
                ? { namespaceId: { not: categoryNamespace.id } }
                : {}),
            status: { in: ['normal', 'active', 'published'] },
            pageType: { not: 'redirect' }
          }
        })
      : [];
    const namespaceIds = [...new Set(pages.map((page) => page.namespaceId))];
    const namespaces = namespaceIds.length > 0
      ? await this.prisma.wikiNamespace.findMany({ where: { id: { in: namespaceIds } }, select: { id: true, code: true } })
      : [];
    const namespaceById = new Map(namespaces.map((item) => [item.id, item.code]));
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const routePaths = await this.routePaths.preload(pages, namespaceById);
    const items: WikiCategoryResponse['items'][number][] = [];
    let lastScannedId: bigint | null = null;
    for (const link of links) {
      lastScannedId = link.id;
      const page = pageById.get(link.sourcePageId);
      if (!page || page.currentRevisionId !== link.sourceRevisionId) continue;
      try {
        await this.wikiPermissions.assertCanReadPage({ accountId: input.accountId ?? null, page });
      } catch {
        continue;
      }
      const namespaceCode = namespaceById.get(page.namespaceId) ?? 'main';
      items.push({
        id: link.id.toString(),
        pageId: page.id.toString(),
        namespace: namespaceCode,
        title: page.title,
        displayTitle: page.displayTitle,
        routePath: routePaths.routePath(page, namespaceCode),
        updatedAt: page.updatedAt.toISOString()
      });
      if (items.length >= limit) break;
    }
    const mayHaveMore = links.length > 0 && (items.length >= limit || links.length >= scanLimit);
    return {
      category,
      document: readableCategoryPage ? {
        pageId: readableCategoryPage.id.toString(),
        routePath: wikiUrl('category', readableCategoryPage.title)
      } : null,
      parents,
      subcategories,
      isRoot,
      isOrphan: Boolean(readableCategoryPage && !reachesRoot),
      items,
      nextCursor: mayHaveMore ? lastScannedId?.toString() ?? null : null
    };
  }

  private async categoryParentsReachRoot(initialParentSlugs: readonly string[], namespaceId: number, accountId: string | null): Promise<boolean> {
    const rootSlug = slugifyTitle('분류');
    const queue = [...initialParentSlugs];
    const visited = new Set<string>();
    while (queue.length > 0 && visited.size < 1000) {
      const slug = queue.shift();
      if (!slug || visited.has(slug)) continue;
      if (slug === rootSlug) return true;
      visited.add(slug);
      const page = await this.prisma.wikiPage.findUnique({
        where: { namespaceId_slug: { namespaceId, slug } }
      });
      if (!page || page.status === 'deleted' || !page.currentRevisionId) continue;
      try {
        await this.wikiPermissions.assertCanReadPage({ accountId, page });
      } catch {
        continue;
      }
      const links = await this.prisma.wikiPageLink.findMany({
        where: {
          sourcePageId: page.id,
          sourceRevisionId: page.currentRevisionId,
          targetNamespaceCode: 'category',
          linkType: 'category'
        },
        orderBy: [{ targetSlug: 'asc' }],
        take: 100
      });
      for (const link of links) if (!visited.has(link.targetSlug)) queue.push(link.targetSlug);
    }
    return false;
  }

  async getDocumentTemplates(input: {
    readonly accountId?: string | null;
    readonly pageId?: string;
  }): Promise<WikiDocumentTemplateSummary[]> {
    let spaceId: bigint | null = null;
    if (input.pageId) {
      const page = await this.prisma.wikiPage.findUnique({ where: { id: this.parseBigIntId(input.pageId, 'pageId') } });
      if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
      await this.wikiPermissions.assertCanReadPage({ accountId: input.accountId ?? null, page });
      spaceId = page.spaceId;
    }
    const profile = input.accountId
      ? await this.prisma.wikiProfile.findUnique({ where: { accountId: input.accountId }, select: { id: true } })
      : null;
    const templates = await this.prisma.documentTemplate.findMany({
      where: {
        status: 'active',
        OR: [
          { templateScope: 'global', spaceId: null },
          ...(spaceId ? [{ templateScope: 'space', spaceId }] : []),
          ...(profile ? [{ templateScope: 'user', createdBy: profile.id }] : [])
        ]
      },
      orderBy: [{ templateScope: 'asc' }, { title: 'asc' }, { id: 'asc' }],
      take: 80
    });
    return templates.map((template) => ({
      id: template.id.toString(),
      key: template.templateKey,
      title: template.title,
      description: template.description,
      scope: template.templateScope,
      targetArea: template.targetArea,
      defaultCategory: template.defaultCategory,
      contentRaw: template.contentRaw
    }));
  }

  async getContributions(input: {
    readonly profileId: string;
    readonly accountId?: string | null;
    readonly cursor?: string;
    readonly limit?: string | number;
    readonly activity?: string;
  }): Promise<WikiContributionResponse> {
    const profileId = this.parseBigIntId(input.profileId, 'profileId');
    const profile = await this.prisma.wikiProfile.findUnique({
      where: { id: profileId },
      select: { id: true, username: true, displayName: true, status: true }
    });
    if (!profile || !['active', 'blocked'].includes(profile.status)) throw new NotFoundException('Wiki profile not found.');
    const limit = Math.min(Math.max(Number(input.limit ?? 30) || 30, 1), 100);
    const cursor = input.cursor ? this.parseBigIntId(input.cursor, 'cursor') : null;
    const activity = input.activity ?? 'edits';
    if (!['edits', 'discussions', 'edit-requests', 'reviews'].includes(activity)) throw new BadRequestException('activity is invalid.');
    const common = { profile, accountId: input.accountId ?? null, cursor, limit };
    if (activity === 'discussions') return this.getDiscussionContributions(common);
    if (activity === 'edit-requests') return this.getEditRequestContributions(common, false);
    if (activity === 'reviews') return this.getEditRequestContributions(common, true);
    const changes = await this.prisma.wikiRecentChange.findMany({
      where: {
        actorId: profile.id,
        pageId: { not: null },
        ...(cursor ? { id: { lt: cursor } } : {})
      },
      orderBy: [{ id: 'desc' }],
      take: Math.min(limit * 4 + 1, 401)
    });
    const pageIds = [...new Set(changes.flatMap((change) => change.pageId ? [change.pageId] : []))];
    const pages = pageIds.length > 0 ? await this.prisma.wikiPage.findMany({ where: { id: { in: pageIds } } }) : [];
    const namespaceIds = [...new Set(pages.map((page) => page.namespaceId))];
    const namespaces = namespaceIds.length > 0
      ? await this.prisma.wikiNamespace.findMany({ where: { id: { in: namespaceIds } } })
      : [];
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const routePaths = await this.routePaths.preload(pages, namespaceById);
    const items: WikiContributionItem[] = [];
    let lastScannedId: bigint | null = null;
    for (const change of changes) {
      lastScannedId = change.id;
      if (!change.pageId) continue;
      const page = pageById.get(change.pageId);
      if (!page) continue;
      try {
        await this.wikiPermissions.assertCanReadPage({ accountId: input.accountId ?? null, page });
      } catch {
        continue;
      }
      const namespace = namespaceById.get(page.namespaceId) ?? change.namespaceCode;
      items.push({
        id: change.id.toString(),
        kind: 'document',
        pageId: page.id.toString(),
        revisionId: change.revisionId?.toString() ?? null,
        changeType: change.changeType,
        title: page.displayTitle,
        namespace,
        routePath: routePaths.routePath(page, namespace),
        href: change.revisionId ? `/wiki/revision/${change.revisionId.toString()}` : routePaths.routePath(page, namespace),
        summary: change.summary,
        isMinor: change.isMinor,
        status: null,
        createdAt: change.createdAt.toISOString()
      });
      if (items.length >= limit) break;
    }
    const mayHaveMore = changes.length > 0 && (items.length >= limit || changes.length >= Math.min(limit * 4 + 1, 401));
    return {
      activity: 'edits',
      profile: {
        id: profile.id.toString(),
        username: profile.username,
        displayName: profile.displayName,
        status: profile.status
      },
      items,
      nextCursor: mayHaveMore ? lastScannedId?.toString() ?? null : null
    };
  }

  private async getDiscussionContributions(input: {
    readonly profile: { readonly id: bigint; readonly username: string; readonly displayName: string; readonly status: string };
    readonly accountId: string | null;
    readonly cursor: bigint | null;
    readonly limit: number;
  }): Promise<WikiContributionResponse> {
    const scanLimit = Math.min(input.limit * 4 + 1, 401);
    const comments = await this.prisma.wikiDiscussionComment.findMany({
      where: { createdBy: input.profile.id, ...(input.cursor ? { id: { lt: input.cursor } } : {}) },
      orderBy: [{ id: 'desc' }],
      take: scanLimit
    });
    const threadIds = [...new Set(comments.map((comment) => comment.threadId))];
    const threads = threadIds.length > 0 ? await this.prisma.wikiDiscussionThread.findMany({ where: { id: { in: threadIds } } }) : [];
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const pageIds = [...new Set(threads.map((thread) => thread.pageId))];
    const pages = pageIds.length > 0 ? await this.prisma.wikiPage.findMany({ where: { id: { in: pageIds } } }) : [];
    const namespaces = pages.length > 0 ? await this.prisma.wikiNamespace.findMany({ where: { id: { in: [...new Set(pages.map((page) => page.namespaceId))] } } }) : [];
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const routePaths = await this.routePaths.preload(pages, namespaceById);
    const readable = new Map<bigint, boolean>();
    const items: WikiContributionItem[] = [];
    let lastScannedId: bigint | null = null;
    for (const comment of comments) {
      lastScannedId = comment.id;
      const thread = threadById.get(comment.threadId);
      if (!thread || thread.status === 'deleted') continue;
      const page = pageById.get(thread.pageId);
      if (!page || !(await this.canReadContributionPage(page, input.accountId, readable))) continue;
      const namespace = namespaceById.get(page.namespaceId) ?? 'main';
      const serverSlug = namespace === 'server' ? routePaths.serverSlug(page) : undefined;
      const routePath = routePaths.routePath(page, namespace);
      items.push({
        id: comment.id.toString(), kind: 'discussion', pageId: page.id.toString(), revisionId: null,
        changeType: 'comment', title: thread.title, namespace, routePath,
        href: serverSlug
          ? `${buildServerWikiToolPath(serverSlug, page.localPath, 'discuss')}?thread=${thread.id.toString()}&comment=${comment.id.toString()}`
          : `/wiki/discuss/${page.id.toString()}?thread=${thread.id.toString()}&comment=${comment.id.toString()}`,
        summary: comment.status === 'normal' ? comment.content.slice(0, 255) : '삭제된 댓글', isMinor: false,
        status: thread.status, createdAt: comment.createdAt.toISOString()
      });
      if (items.length >= input.limit) break;
    }
    return this.contributionResponse('discussions', input.profile, items, comments, lastScannedId, input.limit, scanLimit);
  }

  private async getEditRequestContributions(input: {
    readonly profile: { readonly id: bigint; readonly username: string; readonly displayName: string; readonly status: string };
    readonly accountId: string | null;
    readonly cursor: bigint | null;
    readonly limit: number;
  }, reviews: boolean): Promise<WikiContributionResponse> {
    const scanLimit = Math.min(input.limit * 4 + 1, 401);
    const requests = await this.prisma.wikiEditRequest.findMany({
      where: reviews
        ? { reviewedBy: input.profile.id, reviewedAt: { not: null }, ...(input.cursor ? { id: { lt: input.cursor } } : {}) }
        : { createdBy: input.profile.id, ...(input.cursor ? { id: { lt: input.cursor } } : {}) },
      orderBy: [{ id: 'desc' }],
      take: scanLimit
    });
    const pageIds = [...new Set(requests.map((request) => request.pageId))];
    const pages = pageIds.length > 0 ? await this.prisma.wikiPage.findMany({ where: { id: { in: pageIds } } }) : [];
    const namespaces = pages.length > 0 ? await this.prisma.wikiNamespace.findMany({ where: { id: { in: [...new Set(pages.map((page) => page.namespaceId))] } } }) : [];
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const routePaths = await this.routePaths.preload(pages, namespaceById);
    const readable = new Map<bigint, boolean>();
    const items: WikiContributionItem[] = [];
    let lastScannedId: bigint | null = null;
    for (const request of requests) {
      lastScannedId = request.id;
      const page = pageById.get(request.pageId);
      if (!page || !(await this.canReadContributionPage(page, input.accountId, readable))) continue;
      const namespace = namespaceById.get(page.namespaceId) ?? 'main';
      const routePath = routePaths.routePath(page, namespace);
      const serverSlug = namespace === 'server' ? routePaths.serverSlug(page) : undefined;
      items.push({
        id: request.id.toString(), kind: reviews ? 'review' : 'edit_request', pageId: page.id.toString(), revisionId: request.acceptedRevisionId?.toString() ?? null,
        changeType: reviews ? 'review' : 'edit_request', title: page.displayTitle, namespace, routePath,
        href: serverSlug
          ? `${buildServerWikiToolPath(serverSlug, page.localPath, 'requests')}?request=${request.id.toString()}`
          : `/wiki/edit-requests/${page.id.toString()}?returnTo=${encodeURIComponent(routePath)}&request=${request.id.toString()}`,
        summary: reviews ? request.reviewNote ?? request.editSummary : request.editSummary,
        isMinor: request.isMinor, status: request.status,
        createdAt: (reviews ? request.reviewedAt ?? request.updatedAt : request.createdAt).toISOString()
      });
      if (items.length >= input.limit) break;
    }
    return this.contributionResponse(reviews ? 'reviews' : 'edit-requests', input.profile, items, requests, lastScannedId, input.limit, scanLimit);
  }

  private async canReadContributionPage(page: Parameters<WikiPermissionService['assertCanReadPage']>[0]['page'] & { id: bigint }, accountId: string | null, cache: Map<bigint, boolean>): Promise<boolean> {
    const cached = cache.get(page.id);
    if (cached !== undefined) return cached;
    try {
      await this.wikiPermissions.assertCanReadPage({ accountId, page });
      cache.set(page.id, true);
      return true;
    } catch {
      cache.set(page.id, false);
      return false;
    }
  }

  private contributionResponse(
    activity: WikiContributionResponse['activity'],
    profile: { readonly id: bigint; readonly username: string; readonly displayName: string; readonly status: string },
    items: WikiContributionItem[], scanned: ReadonlyArray<unknown>, lastScannedId: bigint | null, limit: number, scanLimit: number
  ): WikiContributionResponse {
    return {
      activity,
      profile: { id: profile.id.toString(), username: profile.username, displayName: profile.displayName, status: profile.status },
      items,
      nextCursor: scanned.length > 0 && (items.length >= limit || scanned.length >= scanLimit) ? lastScannedId?.toString() ?? null : null
    };
  }

  async getDeletedPages(input: {
    readonly accountId: string;
    readonly profileId: bigint;
    readonly includeAll?: boolean;
  }): Promise<WikiDeletedPageSummary[]> {
    let managedSpaceIds: bigint[] = [];
    if (!input.includeAll) {
      const [spaces, roles, servers, verifiedMods] = await Promise.all([
        this.prisma.wikiSpace.findMany({
          where: { OR: [{ ownerUserId: input.profileId }, { createdBy: input.profileId }] },
          select: { id: true }
        }),
        this.prisma.subwikiRole.findMany({
          where: {
            userId: input.profileId,
            status: 'active',
            role: { in: ['owner', 'manager', 'maintainer'] }
          },
          select: { spaceId: true }
        }),
        this.prisma.server.findMany({ where: { ownerAccountId: input.accountId }, select: { id: true } }),
        this.prisma.modWiki.findMany({ where: { verifiedBy: input.profileId }, select: { spaceId: true } })
      ]);
      const ownedServerIds = servers.map((server) => server.id);
      const serverWikis = ownedServerIds.length > 0
        ? await this.prisma.serverWiki.findMany({
            where: { voteServerId: { in: ownedServerIds } },
            select: { spaceId: true }
          })
        : [];
      managedSpaceIds = [...new Set([
        ...spaces.map((space) => space.id),
        ...roles.map((role) => role.spaceId),
        ...serverWikis.map((wiki) => wiki.spaceId),
        ...verifiedMods.map((wiki) => wiki.spaceId)
      ])];
    }
    const pages = await this.prisma.wikiPage.findMany({
      where: {
        status: 'deleted',
        ...(!input.includeAll
          ? {
              OR: [
                { createdBy: input.profileId },
                ...(managedSpaceIds.length > 0 ? [{ spaceId: { in: managedSpaceIds } }] : [])
              ]
            }
          : {})
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 100
    });
    const namespaceIds = [...new Set(pages.map((page) => page.namespaceId))];
    const namespaces = namespaceIds.length > 0
      ? await this.prisma.wikiNamespace.findMany({ where: { id: { in: namespaceIds } } })
      : [];
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    return pages.map((page) => ({
      id: page.id.toString(),
      namespace: namespaceById.get(page.namespaceId) ?? 'main',
      title: page.title,
      displayTitle: page.displayTitle,
      spaceId: page.spaceId.toString(),
      updatedAt: page.updatedAt.toISOString()
    }));
  }

  async getSpecialDocuments(input: {
    readonly type?: string;
    readonly namespace?: string;
    readonly limit?: string | number;
    readonly accountId?: string | null;
  }): Promise<WikiSpecialDocumentResponse> {
    const allowedTypes: WikiSpecialDocumentType[] = [
      'random',
      'orphaned',
      'orphaned_categories',
      'wanted',
      'categories',
      'uncategorized',
      'old',
      'long',
      'short'
    ];
    const type = allowedTypes.includes(input.type as WikiSpecialDocumentType)
      ? input.type as WikiSpecialDocumentType
      : 'orphaned';
    const limit = Math.min(Math.max(Number(input.limit ?? 50) || 50, 1), 100);
    const namespace = input.namespace?.trim()
      ? await this.prisma.wikiNamespace.findUnique({ where: { code: input.namespace.trim() } })
      : null;
    if (input.namespace?.trim() && !namespace) return { type, items: [] };
    if (type === 'orphaned_categories' && namespace && namespace.code !== 'category') return { type, items: [] };
    if (type === 'random' || type === 'old' || type === 'long' || type === 'short' || type === 'uncategorized') {
      return this.getIndexedSpecialDocuments(type, limit, namespace?.id, input.accountId ?? null);
    }
    return this.getSnapshotSpecialDocuments(type, limit, namespace?.code ?? '', input.accountId ?? null);
  }

  private async getSnapshotSpecialDocuments(
    type: 'orphaned' | 'orphaned_categories' | 'wanted' | 'categories',
    limit: number,
    namespaceCode: string,
    accountId: string | null
  ): Promise<WikiSpecialDocumentResponse> {
    const snapshot = await this.prisma.wikiSpecialSnapshot.findUnique({
      where: { type_namespaceCode: { type, namespaceCode } }
    });
    if (!snapshot) {
      return { type, items: [], generation: null, generatedAt: null, isRebuilding: true, isStale: true };
    }
    const snapshotItems = parseSpecialSnapshotItems(snapshot.items);
    const pageIds = snapshotItems.flatMap((item) => item.pageId ? [BigInt(item.pageId)] : []);
    const pages = pageIds.length > 0
      ? await this.prisma.wikiPage.findMany({ where: { id: { in: pageIds } } })
      : [];
    const readablePages = await this.wikiPermissions.filterReadablePages({ accountId, pages });
    const readablePageIds = new Set(readablePages.map((page) => page.id.toString()));
    const items: WikiSpecialDocumentItem[] = [];
    for (const item of snapshotItems) {
      if (item.pageId && !readablePageIds.has(item.pageId)) continue;
      items.push(item);
      if (items.length >= limit) break;
    }
    const stale = Date.now() - snapshot.generatedAt.getTime() > 30 * 60 * 1000;
    return {
      type,
      items,
      generation: snapshot.generation,
      generatedAt: snapshot.generatedAt.toISOString(),
      isRebuilding: false,
      isStale: stale
    };
  }

  private async getIndexedSpecialDocuments(
    type: 'random' | 'old' | 'long' | 'short' | 'uncategorized',
    limit: number,
    namespaceId: number | undefined,
    accountId: string | null
  ): Promise<WikiSpecialDocumentResponse> {
    const scanBudget = Math.min(Math.max(limit * 5, 50), 500);
    const where = {
      namespaceId,
      status: { in: ['normal', 'active', 'published'] },
      pageType: { not: 'redirect' },
      currentRevisionId: { not: null },
      ...(type === 'uncategorized' ? { currentCategoryCount: 0 } : {})
    };
    let candidates: WikiPage[];
    if (type === 'random') {
      const bounds = await this.prisma.wikiPage.aggregate({
        where,
        _min: { id: true },
        _max: { id: true }
      });
      if (bounds._min.id === null || bounds._max.id === null) return { type, items: [] };
      const anchor = randomBigIntBetween(bounds._min.id, bounds._max.id);
      const after = await this.prisma.wikiPage.findMany({
        where: { ...where, id: { gte: anchor } },
        orderBy: [{ id: 'asc' }],
        take: scanBudget
      });
      const remaining = scanBudget - after.length;
      const before = remaining > 0
        ? await this.prisma.wikiPage.findMany({
            where: { ...where, id: { lt: anchor } },
            orderBy: [{ id: 'asc' }],
            take: remaining
          })
        : [];
      candidates = [...after, ...before];
    } else {
      const orderBy = type === 'old'
        ? [{ updatedAt: 'asc' as const }, { id: 'asc' as const }]
        : type === 'long'
          ? [{ currentContentSize: 'desc' as const }, { id: 'desc' as const }]
          : type === 'short'
            ? [{ currentContentSize: 'asc' as const }, { id: 'asc' as const }]
            : [{ updatedAt: 'desc' as const }, { id: 'desc' as const }];
      candidates = await this.prisma.wikiPage.findMany({ where, orderBy, take: scanBudget });
    }

    const visible = await this.wikiPermissions.filterReadablePages({ accountId, pages: candidates });
    const selected = type === 'random'
      ? visible.length > 0 ? [visible[Math.floor(Math.random() * visible.length)]!] : []
      : visible.slice(0, limit);
    const namespaceIds = [...new Set(selected.map((page) => page.namespaceId))];
    const namespaces = namespaceIds.length > 0
      ? await this.prisma.wikiNamespace.findMany({
          where: { id: { in: namespaceIds } },
          select: { id: true, code: true }
        })
      : [];
    const namespaceById = new Map(namespaces.map((item) => [item.id, item.code]));
    const routePaths = await this.routePaths.preload(selected, namespaceById);
    return {
      type,
      items: selected.map((page) => this.specialPageItem(
        page,
        namespaceById.get(page.namespaceId) ?? 'main',
        type === 'long' || type === 'short' ? page.currentContentSize : null,
        routePaths
      ))
    };
  }

  async getBlame(pageId: string, accountId?: string | null): Promise<WikiBlameResponse> {
    const id = this.parseBigIntId(pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id } });
    if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
    await this.wikiPermissions.assertCanReadPage({ accountId: accountId ?? null, page });
    await this.wikiPermissions.assertCanUsePageAction({ accountId: accountId ?? null, action: 'history', page });
    const total = await this.prisma.wikiPageRevision.count({ where: { pageId: page.id, visibility: 'public' } });
    const revisions = await this.prisma.wikiPageRevision.findMany({
      where: { pageId: page.id, visibility: 'public' },
      orderBy: [{ revisionNo: 'asc' }],
      ...(total > 500 ? { skip: total - 500 } : {}),
      take: 500,
      select: { id: true, revisionNo: true, contentRaw: true, createdBy: true, createdAt: true }
    });
    const current = revisions.at(-1);
    if (!current) throw new NotFoundException('Public wiki revision not found.');

    type Attribution = { revisionId: bigint; revisionNo: number; createdBy: bigint | null; createdAt: Date };
    let lines: string[] = [];
    let attribution: Attribution[] = [];
    const lineLimit = 5_000;
    for (const revision of revisions) {
      const nextLines = revision.contentRaw.replace(/\r\n/g, '\n').split('\n').slice(0, lineLimit);
      const nextAttribution: Attribution = {
        revisionId: revision.id,
        revisionNo: revision.revisionNo,
        createdBy: revision.createdBy,
        createdAt: revision.createdAt
      };
      attribution = transferLineAttribution(lines, attribution, nextLines, nextAttribution);
      lines = nextLines;
    }
    const profileIds = [...new Set(attribution.flatMap((item) => item.createdBy ? [item.createdBy] : []))];
    const profiles = profileIds.length > 0
      ? await this.prisma.wikiProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, displayName: true } })
      : [];
    const nameById = new Map(profiles.map((profile) => [profile.id, profile.displayName]));
    return {
      pageId: page.id.toString(),
      revisionId: current.id.toString(),
      revisionNo: current.revisionNo,
      revisionCount: total,
      truncatedHistory: total > revisions.length,
      lineCount: current.contentRaw.replace(/\r\n/g, '\n').split('\n').length,
      truncatedLines: current.contentRaw.replace(/\r\n/g, '\n').split('\n').length > lineLimit,
      lines: lines.map((content, index) => {
        const source = attribution[index]!;
        return {
          lineNo: index + 1,
          content,
          revisionId: source.revisionId.toString(),
          revisionNo: source.revisionNo,
          createdBy: source.createdBy?.toString() ?? null,
          createdByName: source.createdBy ? nameById.get(source.createdBy) ?? '알 수 없는 사용자' : '알 수 없는 사용자',
          createdAt: source.createdAt.toISOString()
        };
      })
    };
  }

  private specialPageItem(
    page: { id: bigint; namespaceId: number; spaceId: bigint; localPath: string; title: string; displayTitle: string; updatedAt: Date },
    namespace: string,
    value: number | null,
    routePaths?: WikiRoutePathBatch
  ): WikiSpecialDocumentItem {
    return {
      id: page.id.toString(), pageId: page.id.toString(), namespace, title: page.title, displayTitle: page.displayTitle,
      routePath: routePaths?.routePath(page, namespace) ?? wikiUrl(namespace as Parameters<typeof wikiUrl>[0], page.title), value, updatedAt: page.updatedAt.toISOString()
    };
  }

  async search(input: {
    readonly q?: string;
    readonly namespace?: string;
    readonly limit?: string | number;
    readonly cursor?: string;
    readonly accountId?: string | null;
  }): Promise<WikiSearchResponse> {
    const query = input.q?.trim() ?? '';
    if (!query) {
      return { items: [], nextCursor: null };
    }
    if (query.length > 100) throw new BadRequestException('q is too long.');
    const limit = Math.min(Math.max(Number(input.limit ?? 20) || 20, 1), 50);
    const cursor = parseWikiSearchCursor(input.cursor);
    const namespace = input.namespace?.trim()
      ? await this.prisma.wikiNamespace.findUnique({ where: { code: input.namespace.trim() } })
      : null;
    if (input.namespace?.trim() && !namespace) {
      return { items: [], nextCursor: null };
    }

    const scanLimit = Math.max(limit * 4, 50);
    const currentMatchIds = await findCurrentSearchMatchIds(this.prisma, {
      query,
      namespaceId: namespace?.id ?? null,
      cursor,
      limit: scanLimit + 1
    });
    const hasCandidateSentinel = currentMatchIds.length > scanLimit;
    const candidateIds = currentMatchIds.slice(0, scanLimit);
    const unorderedPages = candidateIds.length > 0
      ? await this.prisma.wikiPage.findMany({ where: { id: { in: candidateIds } } })
      : [];
    const pageById = new Map(unorderedPages.map((page) => [page.id, page]));
    const pages = candidateIds.flatMap((id) => {
      const page = pageById.get(id);
      return page ? [page] : [];
    });
    const currentRevisionIds = pages.flatMap((page) => page.currentRevisionId ? [page.currentRevisionId] : []);
    const revisionVisibility = currentRevisionIds.length > 0
      ? await this.prisma.wikiPageRevision.findMany({
          where: {
            id: { in: currentRevisionIds },
            visibility: 'public'
          },
          select: { id: true, visibility: true }
        })
      : [];
    const publicRevisionIds = new Set(revisionVisibility.map((revision) => revision.id));
    const publicPages = pages.filter((page) => page.currentRevisionId && publicRevisionIds.has(page.currentRevisionId));
    const readablePages = await this.wikiPermissions.filterReadablePages({
      accountId: input.accountId ?? null,
      pages: publicPages
    });
    const resultPages = readablePages.slice(0, limit);
    const namespaceIds = [...new Set(resultPages.map((page) => page.namespaceId))];
    const namespaces = namespaceIds.length > 0
      ? await this.prisma.wikiNamespace.findMany({
          where: { id: { in: namespaceIds } },
          select: { id: true, code: true }
        })
      : [];
    const namespaceById = new Map(namespaces.map((item) => [item.id, item.code]));
    const routePaths = await this.routePaths.preload(resultPages, namespaceById);
    const resultRevisionIds = resultPages.flatMap((page) => page.currentRevisionId ? [page.currentRevisionId] : []);
    const revisions = resultRevisionIds.length > 0
      ? await this.prisma.wikiPageRevision.findMany({
          where: { id: { in: resultRevisionIds }, visibility: 'public' },
          select: { id: true, contentRaw: true }
        })
      : [];
    const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
    const items: WikiSearchResult[] = [];
    for (const page of resultPages) {
      const revision = page.currentRevisionId ? revisionById.get(page.currentRevisionId) : null;
      if (!revision) continue;
      const namespaceCode = namespaceById.get(page.namespaceId) ?? 'main';
      items.push({
        pageId: page.id.toString(),
        namespace: namespaceCode,
        title: page.title,
        displayTitle: page.displayTitle,
        routePath: routePaths.routePath(page, namespaceCode),
        snippet: makeSearchSnippet(revision.contentRaw, query),
        updatedAt: page.updatedAt.toISOString()
      });
    }
    const lastVisiblePage = resultPages.at(-1);
    const lastScannedPage = pages.at(-1);
    const hasMore = readablePages.length > limit || hasCandidateSentinel;
    const cursorPage = readablePages.length > limit ? lastVisiblePage : lastScannedPage;
    return {
      items,
      nextCursor: hasMore && cursorPage ? encodeWikiSearchCursor(cursorPage.updatedAt, cursorPage.id) : null
    };
  }

  async suggest(input: {
    readonly q?: string;
    readonly limit?: string | number;
    readonly accountId?: string | null;
  }): Promise<WikiSearchSuggestionResponse> {
    const query = input.q?.trim().slice(0, 100) ?? '';
    if (!query) return { items: [], exactMatch: null };
    const limit = Math.min(Math.max(Number(input.limit ?? 8) || 8, 1), 20);
    const slug = slugifyTitle(query);
    const pages = await this.prisma.wikiPage.findMany({
      where: {
        status: { in: ['normal', 'active', 'published'] },
        pageType: { not: 'redirect' },
        currentRevisionId: { not: null },
        OR: [
          { title: { contains: query } },
          { displayTitle: { contains: query } },
          ...(slug ? [{ slug: { contains: slug } }, { localPath: { contains: slug } }] : [])
        ]
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 200
    });
    const namespaces = pages.length > 0
      ? await this.prisma.wikiNamespace.findMany({
          where: { id: { in: [...new Set(pages.map((page) => page.namespaceId))] } },
          select: { id: true, code: true }
        })
      : [];
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const routePaths = await this.routePaths.preload(pages, namespaceById);
    const normalized = query.toLocaleLowerCase('ko-KR');
    const ranked: Array<{ score: number; exact: boolean; item: WikiSearchResult }> = [];
    for (const page of pages) {
      try {
        await this.wikiPermissions.assertCanReadPage({ accountId: input.accountId ?? null, page });
      } catch {
        continue;
      }
      const candidates = [page.displayTitle, page.title, page.slug, page.localPath]
        .map((value) => value.toLocaleLowerCase('ko-KR'));
      const namespace = namespaceById.get(page.namespaceId) ?? 'main';
      const exact = candidates.some((value) => value === normalized);
      const matchRank = exact ? 0 : candidates.some((value) => value.startsWith(normalized)) ? 2 : 4;
      const score = matchRank + (namespace === 'main' ? 0 : 1);
      ranked.push({
        score,
        exact,
        item: {
          pageId: page.id.toString(), namespace, title: page.title, displayTitle: page.displayTitle,
          routePath: routePaths.routePath(page, namespace), snippet: '', updatedAt: page.updatedAt.toISOString()
        }
      });
    }
    ranked.sort((left, right) => left.score - right.score || right.item.updatedAt.localeCompare(left.item.updatedAt) || left.item.pageId.localeCompare(right.item.pageId));
    const items = ranked.slice(0, limit).map(({ item }) => item);
    const exact = ranked.filter((entry) => entry.exact);
    const mainExact = exact.filter((entry) => entry.item.namespace === 'main');
    const exactMatch = mainExact.length === 1
      ? mainExact[0].item
      : exact.length === 1
        ? exact[0].item
        : null;
    return { items, exactMatch };
  }

  private async findMissingLinks(
    sourceNamespace: string,
    sourceLocalPath: string,
    targets: readonly string[],
    accountId: string | null
  ): Promise<Set<string>> {
    const resolvedByLinkKey = new Map<string, { namespace: string; slug: string }>();
    for (const target of targets) {
      const resolved = resolveContextualLinkTarget(sourceNamespace, sourceLocalPath, target);
      const slug = slugifyTitle(resolved.title);
      if (slug) resolvedByLinkKey.set(wikiLinkKey(target), { namespace: resolved.namespace, slug });
    }
    if (resolvedByLinkKey.size === 0) return new Set();

    const namespaceRows = await this.prisma.wikiNamespace.findMany({
      where: { code: { in: [...new Set([...resolvedByLinkKey.values()].map((item) => item.namespace))] } },
      select: { id: true, code: true }
    });
    const namespaceIdByCode = new Map(namespaceRows.map((item) => [item.code, item.id]));
    const readableTargets = new Set<string>();
    for (const namespace of namespaceRows) {
      const slugs = [...new Set([...resolvedByLinkKey.values()]
        .filter((item) => item.namespace === namespace.code)
        .map((item) => item.slug))];
      if (slugs.length === 0) continue;
      const pages = await this.prisma.wikiPage.findMany({
        where: {
          namespaceId: namespace.id,
          slug: { in: slugs },
          status: { not: 'deleted' }
        }
      });
      for (const targetPage of pages) {
        try {
          await this.wikiPermissions.assertCanReadPage({ accountId, page: targetPage });
          readableTargets.add(`${namespace.code}:${targetPage.slug}`);
        } catch {
          // Restricted targets must be indistinguishable from missing pages.
        }
      }
    }

    const missing = new Set<string>();
    for (const [linkKey, target] of resolvedByLinkKey) {
      if (!namespaceIdByCode.has(target.namespace) || !readableTargets.has(`${target.namespace}:${target.slug}`)) {
        missing.add(linkKey);
      }
    }
    return missing;
  }

  private async renderPage(namespace: string, page: {
    namespaceId?: number;
    id: bigint;
    spaceId: bigint;
    localPath: string;
    slug: string;
    title: string;
    displayTitle: string;
    currentRevisionId: bigint | null;
    pageType: string;
    protectionLevel: string;
    status: string;
    updatedAt: Date;
  }, accountId: string | null, options: {
    readonly followRedirects: boolean;
    readonly redirectTrail: readonly string[];
  }): Promise<WikiPageResponse> {
    const revision = page.currentRevisionId
      ? await this.prisma.wikiPageRevision.findFirst({
          where: {
            id: page.currentRevisionId,
            pageId: page.id,
            visibility: 'public'
          }
        })
      : await this.prisma.wikiPageRevision.findFirst({
          where: {
            pageId: page.id,
            visibility: 'public'
          },
          orderBy: [{ revisionNo: 'desc' }]
        });

    if (!revision) {
      throw new NotFoundException('Public wiki revision not found.');
    }
    await this.wikiPermissions.assertCanReadPage({
      accountId,
      page,
      revision
    });
    const parsed = parseMarkup(revision.contentRaw);
    await this.wikiLinks?.replaceForRevision(
      this.prisma,
      page.id,
      revision.id,
      parsed.links,
      parsed.categories,
      parsed.includes,
      { contentSize: revision.contentSize, contentRaw: revision.contentRaw }
    ).catch(() => undefined);
    if (parsed.redirectTarget && options.followRedirects) {
      const target = resolveContextualLinkTarget(namespace, page.localPath, parsed.redirectTarget);
      const redirected = await this.getPageInternal(target.namespace, target.title, accountId, {
        followRedirects: true,
        redirectTrail: [...options.redirectTrail, `${namespace}:${page.slug}`]
      });
      return {
        ...redirected,
        redirectedFrom: redirected.redirectedFrom ?? {
          namespace,
          title: page.title,
          path: wikiUrl(namespace as Parameters<typeof wikiUrl>[0], page.title)
        }
      };
    }

    const serverWiki = await this.findServerWikiContext(namespace, page.spaceId, page.id);
    const expanded = parsed.includes.length > 0 && this.wikiIncludes
      ? await this.wikiIncludes.expand({
          ast: parsed.ast,
          accountId,
          sourcePageId: page.id,
          sourceNamespace: namespace,
          sourceLocalPath: page.localPath
        })
      : { ast: parsed.ast, includedSourceBytes: 0 };
    const hasFileDependencies = collectFileNames(expanded.ast).size > 0;
    const hasIncludeDependencies = parsed.includes.length > 0;
    const hasLinkDependencies = parsed.links.length > 0;
    const cache = hasFileDependencies || hasIncludeDependencies || hasLinkDependencies
      ? null
      : await this.prisma.wikiPageRenderCache.findUnique({
          where: {
            revisionId_rendererVersion: {
              revisionId: revision.id,
              rendererVersion: WIKI_RENDERER_VERSION
            }
          }
        });
    const files = cache ? {} : await this.findRenderableFiles(expanded.ast, accountId);
    const missingLinks = hasLinkDependencies
      ? await this.findMissingLinks(namespace, page.localPath, parsed.links, accountId)
      : new Set<string>();
    const html = cache?.html ?? renderDocument(expanded.ast, {
      files,
      missingLinks,
      internalLinkBasePath: serverWiki ? `/server/${encodeURIComponent(serverWiki.context.slug)}` : undefined,
    });
    if (Buffer.byteLength(html, 'utf8') > 2 * 1024 * 1024) {
      throw new BadRequestException('Rendered wiki document exceeds the size limit.');
    }
    if (!cache && !hasFileDependencies && !hasIncludeDependencies && !hasLinkDependencies) {
      await this.prisma.wikiPageRenderCache
        .create({
          data: {
            pageId: page.id,
            revisionId: revision.id,
            rendererVersion: WIKI_RENDERER_VERSION,
            html,
            createdAt: new Date()
          }
        })
        .catch(() => undefined);
    }
    return {
      id: page.id.toString(),
      namespace,
      spaceId: page.spaceId.toString(),
      slug: page.slug,
      title: page.title,
      displayTitle: page.displayTitle,
      pageType: page.pageType,
      protectionLevel: page.protectionLevel,
      status: page.status,
      updatedAt: page.updatedAt.toISOString(),
      revision: {
        id: revision.id.toString(),
        revisionNo: revision.revisionNo,
        contentHash: revision.contentHash,
        createdAt: revision.createdAt.toISOString(),
        createdBy: revision.createdBy?.toString() ?? null
      },
      html,
      links: parsed.links,
      categories: parsed.categories,
      headings: parsed.headings.map(({ level, title, anchor }) => ({ level, title, anchor })),
      redirectTarget: parsed.redirectTarget,
      redirectedFrom: null,
      serverDirectoryPath: serverWiki?.directoryPath ?? null,
      serverWiki: serverWiki?.context ?? null
    };
  }

  private async findServerWikiContext(namespace: string, spaceId: bigint, currentPageId: bigint) {
    if (namespace !== 'server') {
      return null;
    }
    const serverWiki = await this.prisma.serverWiki.findFirst({
      where: { spaceId },
      select: {
        voteServerId: true,
        serverName: true,
        slug: true,
        host: true,
        port: true,
        edition: true,
        supportedVersions: true,
        genres: true,
        layoutKey: true
      }
    });
    if (!serverWiki) {
      return null;
    }
    const [server, pages] = await Promise.all([
      serverWiki.voteServerId
        ? this.prisma.server.findUnique({
            where: { id: serverWiki.voteServerId },
            select: {
              id: true,
              shortCode: true,
              isOnline: true,
              playersOnline: true,
              playersMax: true
            }
          })
        : null,
      this.prisma.wikiPage.findMany({
        where: { spaceId, status: { not: 'deleted' }, pageType: { not: 'redirect' } },
        select: { id: true, localPath: true, displayTitle: true },
        orderBy: [{ localPath: 'asc' }, { id: 'asc' }]
      })
    ]);
    const navigation = buildServerWikiNavigation(serverWiki.slug, pages, currentPageId);
    return {
      directoryPath: server ? `/servers/${server.shortCode?.trim() || server.id}` : null,
      context: {
        name: serverWiki.serverName,
        slug: serverWiki.slug,
        host: serverWiki.host,
        port: serverWiki.port,
        edition: serverWiki.edition,
        supportedVersions: serverWiki.supportedVersions,
        genres: serverWiki.genres,
        isOnline: server?.isOnline ?? null,
        playersOnline: server?.playersOnline ?? null,
        playersMax: server?.playersMax ?? null,
        layout: normalizeServerWikiLayoutKey(serverWiki.layoutKey),
        navigation
      }
    };
  }

  private async findRenderableFiles(ast: AstNode[], accountId: string | null) {
    const fileNames = Array.from(collectFileNames(ast));
    if (fileNames.length === 0) {
      return {};
    }
    const files = await this.prisma.uploadedFile.findMany({
      where: {
        filename: { in: fileNames },
        usageContext: 'wiki_editor',
        status: 'active'
      }
    });
    const visibleFiles = [];
    for (const file of files) {
      if (file.visibility === 'public' || file.visibility === 'unlisted') {
        visibleFiles.push(file);
        continue;
      }
      if (file.visibility === 'private') {
        if (accountId && file.ownerAccountId === accountId) visibleFiles.push(file);
        continue;
      }
      const linkedId = file.linkedResourceId?.trim();
      if (file.visibility !== 'restricted' || !linkedId || !/^\d+$/.test(linkedId)) continue;
      try {
        if (file.linkedResourceType === 'wiki_page') {
          const linkedPage = await this.prisma.wikiPage.findUnique({ where: { id: BigInt(linkedId) } });
          await this.wikiPermissions.assertCanReadPage({ accountId, page: linkedPage });
          visibleFiles.push(file);
        } else if (file.linkedResourceType === 'wiki_space') {
          await this.wikiPermissions.assertCanReadSpace({ accountId, spaceId: BigInt(linkedId) });
          visibleFiles.push(file);
        }
      } catch {
        // Render the same missing-file placeholder for unreadable and absent files.
      }
    }
    return Object.fromEntries(
      visibleFiles.map((file) => [
        file.filename,
        {
          url: file.publicPath,
          mimeType: file.mimeType,
          originalName: file.originalName ?? file.filename,
          license: file.license,
          sourceUrl: file.sourceUrl,
          sourceText: file.sourceText
        }
      ])
    );
  }

  private parseBigIntId(value: string, label: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException(`${label} must be an unsigned integer.`);
    }
    return BigInt(value);
  }

  private parsePositiveInt(value: string, label: string): number {
    if (!/^\d+$/.test(value)) throw new BadRequestException(`${label} must be a positive integer.`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new BadRequestException(`${label} must be a positive integer.`);
    return parsed;
  }

  private parseRecentFilter(value: string | undefined, label: string): string | undefined {
    const normalized = value?.trim();
    if (!normalized) return undefined;
    if (!/^[a-z0-9_-]{1,32}$/i.test(normalized)) throw new BadRequestException(`${label} is invalid.`);
    return normalized;
  }
}

export function buildServerWikiPagePath(serverSlug: string, localPath: string): string {
  return buildCanonicalServerWikiPath(serverSlug, localPath);
}

export function buildServerWikiToolPath(serverSlug: string, localPath: string, tool: string): string {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(tool)) throw new BadRequestException('Invalid server wiki tool.');
  const rootPath = buildServerWikiPagePath(serverSlug, serverSlug);
  const pagePath = buildServerWikiPagePath(serverSlug, localPath);
  const relativePath = pagePath.slice(rootPath.length);
  return `${rootPath}/_tools/${tool}${relativePath}`;
}

export function serverWikiNavigationDepth(serverSlug: string, localPath: string): number {
  const relativePath = serverWikiRelativePath(serverSlug, localPath);
  return relativePath ? relativePath.split('/').filter(Boolean).length : 0;
}

export function buildServerWikiNavigation(
  serverSlug: string,
  pages: ReadonlyArray<{ id: bigint; localPath: string; displayTitle: string }>,
  currentPageId: bigint
) {
  const navigationPages = [...pages].sort((left, right) => {
    const leftRoot = serverWikiRelativePath(serverSlug, left.localPath) ? 0 : -1;
    const rightRoot = serverWikiRelativePath(serverSlug, right.localPath) ? 0 : -1;
    return leftRoot - rightRoot || left.localPath.localeCompare(right.localPath, 'ko');
  });
  const parentPaths = new Set<string>();
  for (const item of navigationPages) {
    const parts = serverWikiRelativePath(serverSlug, item.localPath).split('/').filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      parentPaths.add(parts.slice(0, index).join('/'));
    }
  }
  return navigationPages.map((item) => {
    const relativePath = serverWikiRelativePath(serverSlug, item.localPath);
    return {
      id: item.id.toString(),
      title: serverWikiNavigationTitle(serverSlug, item.displayTitle),
      path: buildServerWikiPagePath(serverSlug, item.localPath),
      current: item.id === currentPageId,
      depth: serverWikiNavigationDepth(serverSlug, item.localPath),
      hasChildren: parentPaths.has(relativePath)
    };
  });
}

function serverWikiNavigationTitle(serverSlug: string, displayTitle: string): string {
  const title = displayTitle.trim();
  const duplicatedPrefix = `${serverSlug.trim()}/`;
  return title.startsWith(duplicatedPrefix) ? title.slice(duplicatedPrefix.length) : title;
}

function serverWikiRelativePath(serverSlug: string, localPath: string): string {
  const normalizedSlug = serverSlug.trim().replace(/^\/+|\/+$/g, '');
  const normalizedPath = localPath.trim().replace(/^\/+|\/+$/g, '');
  if (normalizedPath === normalizedSlug) return '';
  return normalizedPath.startsWith(`${normalizedSlug}/`)
    ? normalizedPath.slice(normalizedSlug.length + 1)
    : normalizedPath;
}

function resolveContextualLinkTarget(namespace: string, localPath: string, target: string) {
  const parsed = parseLinkTarget(target);
  if (namespace !== 'server' || parsed.namespace !== 'main' || target.includes(':')) {
    return parsed;
  }
  const [serverSlug] = slugifyTitle(localPath).split('/');
  return {
    namespace: 'server' as const,
    title: `${serverSlug}/${parsed.title}`,
  };
}

function normalizeServerWikiLayoutKey(value: string): 'docs' | 'handbook' | 'brand' {
  return value === 'handbook' || value === 'brand' ? value : 'docs';
}

function transferLineAttribution<T>(oldLines: readonly string[], oldAttribution: readonly T[], newLines: readonly string[], fallback: T): T[] {
  const next = newLines.map(() => fallback);
  if (oldLines.length === 0 || newLines.length === 0) return next;
  const matches = oldLines.length * newLines.length <= 2_000_000
    ? longestCommonLineMatches(oldLines, newLines)
    : monotonicLineMatches(oldLines, newLines);
  for (const [oldIndex, newIndex] of matches) {
    if (oldAttribution[oldIndex] !== undefined) next[newIndex] = oldAttribution[oldIndex]!;
  }
  return next;
}

function longestCommonLineMatches(oldLines: readonly string[], newLines: readonly string[]): Array<[number, number]> {
  const rows = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let oldIndex = 1; oldIndex <= oldLines.length; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= newLines.length; newIndex += 1) {
      rows[oldIndex]![newIndex] = oldLines[oldIndex - 1] === newLines[newIndex - 1]
        ? rows[oldIndex - 1]![newIndex - 1]! + 1
        : Math.max(rows[oldIndex - 1]![newIndex]!, rows[oldIndex]![newIndex - 1]!);
    }
  }
  const matches: Array<[number, number]> = [];
  let oldIndex = oldLines.length;
  let newIndex = newLines.length;
  while (oldIndex > 0 && newIndex > 0) {
    if (oldLines[oldIndex - 1] === newLines[newIndex - 1]) {
      matches.push([oldIndex - 1, newIndex - 1]); oldIndex -= 1; newIndex -= 1;
    } else if (rows[oldIndex - 1]![newIndex]! >= rows[oldIndex]![newIndex - 1]!) {
      oldIndex -= 1;
    } else {
      newIndex -= 1;
    }
  }
  return matches.reverse();
}

function monotonicLineMatches(oldLines: readonly string[], newLines: readonly string[]): Array<[number, number]> {
  const oldPositions = new Map<string, number[]>();
  oldLines.forEach((line, index) => oldPositions.set(line, [...(oldPositions.get(line) ?? []), index]));
  const matches: Array<[number, number]> = [];
  let previousOldIndex = -1;
  for (let newIndex = 0; newIndex < newLines.length; newIndex += 1) {
    const candidate = oldPositions.get(newLines[newIndex]!)?.find((index) => index > previousOldIndex);
    if (candidate === undefined) continue;
    matches.push([candidate, newIndex]);
    previousOldIndex = candidate;
  }
  return matches;
}

function collectFileNames(ast: AstNode[], output = new Set<string>()): Set<string> {
  for (const node of ast) {
    if (node.type === 'file') {
      output.add(node.fileName);
    } else if (node.type === 'folding' || (node.type === 'include' && node.children)) {
      collectFileNames(node.children, output);
    }
  }
  return output;
}

function categoryTitleFromSlug(slug: string): string {
  return slug.split('/').map((part) => part.replace(/_/g, ' ')).join('/');
}

async function findCurrentSearchMatchIds(
  prisma: PrismaService,
  input: {
    readonly query: string;
    readonly namespaceId: number | null;
    readonly cursor: { readonly updatedAt: Date; readonly id: bigint } | null;
    readonly limit: number;
  }
): Promise<bigint[]> {
  const booleanQuery = buildWikiSearchBooleanQuery(input.query);
  if (!booleanQuery) return [];
  const where = [
    "p.status IN ('normal', 'active', 'published')",
    "r.visibility = 'public'",
    'MATCH(sd.search_vector) AGAINST (? IN BOOLEAN MODE)'
  ];
  const values: unknown[] = [booleanQuery];
  if (input.namespaceId !== null) {
    where.push('p.namespace_id = ?');
    values.push(input.namespaceId);
  }
  if (input.cursor) {
    where.push('(p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))');
    values.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.id);
  }
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 201);
  const rows = await prisma.$queryRawUnsafe<Array<{ id: bigint | number | string }>>(
    `
      SELECT p.id
      FROM pages AS p
      INNER JOIN wiki_search_documents AS sd
        ON sd.page_id = p.id AND sd.revision_id = p.current_revision_id
      INNER JOIN page_revisions AS r ON r.id = p.current_revision_id
      WHERE ${where.join('\n        AND ')}
      ORDER BY p.updated_at DESC, p.id DESC
      LIMIT ${limit}
    `,
    ...values
  );
  return rows.map((row) => BigInt(row.id));
}

export function encodeWikiSearchCursor(updatedAt: Date, id: bigint): string {
  return `${updatedAt.toISOString()}_${id.toString()}`;
}

export function parseWikiSearchCursor(value: string | undefined): { updatedAt: Date; id: bigint } | null {
  if (!value) return null;
  const separator = value.lastIndexOf('_');
  if (separator <= 0) throw new BadRequestException('cursor is invalid.');
  const updatedAt = new Date(value.slice(0, separator));
  const rawId = value.slice(separator + 1);
  if (Number.isNaN(updatedAt.getTime()) || !/^\d+$/.test(rawId)) throw new BadRequestException('cursor is invalid.');
  return { updatedAt, id: BigInt(rawId) };
}

function randomBigIntBetween(minimum: bigint, maximum: bigint): bigint {
  const span = maximum - minimum + 1n;
  if (span <= 1n) return minimum;
  return minimum + (randomBytes(8).readBigUInt64BE() % span);
}

function parseSpecialSnapshotItems(value: unknown): WikiSpecialDocumentItem[] {
  if (!Array.isArray(value)) return [];
  const items: WikiSpecialDocumentItem[] = [];
  for (const candidate of value.slice(0, 500)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const pageId = item.pageId === null ? null : typeof item.pageId === 'string' && /^\d+$/.test(item.pageId) ? item.pageId : undefined;
    const valueNumber = item.value === null ? null : typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : undefined;
    const updatedAt = item.updatedAt === null ? null : typeof item.updatedAt === 'string' ? item.updatedAt : undefined;
    if (
      typeof item.id !== 'string' ||
      pageId === undefined ||
      typeof item.namespace !== 'string' ||
      typeof item.title !== 'string' ||
      typeof item.displayTitle !== 'string' ||
      typeof item.routePath !== 'string' ||
      !item.routePath.startsWith('/') ||
      valueNumber === undefined ||
      updatedAt === undefined
    ) continue;
    items.push({
      id: item.id,
      pageId,
      namespace: item.namespace,
      title: item.title,
      displayTitle: item.displayTitle,
      routePath: item.routePath,
      value: valueNumber,
      updatedAt
    });
  }
  return items;
}

function makeSearchSnippet(content: string, query: string): string {
  const normalizedContent = content.replace(/\s+/g, ' ').trim();
  const index = normalizedContent.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) {
    return normalizedContent.slice(0, 160);
  }
  const start = Math.max(index - 60, 0);
  const end = Math.min(index + query.length + 100, normalizedContent.length);
  return `${start > 0 ? '...' : ''}${normalizedContent.slice(start, end)}${end < normalizedContent.length ? '...' : ''}`;
}
