import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
  type AstNode,
  parseLinkTarget,
  parseMarkup,
  renderDocument,
  resolveWikiPath,
  slugifyTitle,
  wikiUrl,
  WIKI_RENDERER_VERSION
} from '@minewiki/wiki-core';
import { PrismaService } from '../common/prisma.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiLinkIndexService } from './wiki-link-index.service';

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
  readonly summary: string | null;
  readonly isMinor: boolean;
  readonly createdAt: string;
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
  readonly pageId: string;
  readonly revisionId: string | null;
  readonly changeType: string;
  readonly title: string;
  readonly namespace: string;
  readonly routePath: string;
  readonly summary: string | null;
  readonly isMinor: boolean;
  readonly createdAt: string;
}

export interface WikiContributionResponse {
  readonly profile: {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
  };
  readonly items: WikiContributionItem[];
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

@Injectable()
export class WikiReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiPermissions: WikiPermissionService,
    @Optional() private readonly wikiLinks?: WikiLinkIndexService
  ) {}

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

  async getRevisions(pageId: string, accountId?: string | null): Promise<WikiRevisionSummary[]> {
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
    const revisions = await this.prisma.wikiPageRevision.findMany({
      where: {
        pageId: parsedPageId,
        visibility: 'public'
      },
      orderBy: [{ revisionNo: 'desc' }],
      take: 100
    });
    const profileIds = [...new Set(revisions.flatMap((revision) => revision.createdBy ? [revision.createdBy] : []))];
    const profiles = profileIds.length > 0
      ? await this.prisma.wikiProfile.findMany({
          where: { id: { in: profileIds } },
          select: { id: true, displayName: true }
        })
      : [];
    const profileById = new Map(profiles.map((profile) => [profile.id, profile.displayName]));
    return revisions.map((revision) => ({
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
  }

  async getRecent(accountId?: string | null): Promise<WikiRecentChangeSummary[]> {
    const changes = await this.prisma.wikiRecentChange.findMany({
      orderBy: [{ createdAt: 'desc' }],
      take: 100
    });
    const visible: WikiRecentChangeSummary[] = [];
    for (const change of changes) {
      if (change.pageId) {
        const page = await this.prisma.wikiPage.findUnique({ where: { id: change.pageId } });
        try {
          await this.wikiPermissions.assertCanReadPage({
            accountId: accountId ?? null,
            page
          });
        } catch {
          continue;
        }
      }
      visible.push({
        id: change.id.toString(),
        pageId: change.pageId?.toString() ?? null,
        revisionId: change.revisionId?.toString() ?? null,
        actorId: change.actorId?.toString() ?? null,
        changeType: change.changeType,
        title: change.title,
        namespaceCode: change.namespaceCode,
        summary: change.summary,
        isMinor: change.isMinor,
        createdAt: change.createdAt.toISOString()
      });
      if (visible.length >= 50) {
        break;
      }
    }
    return visible;
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
        routePath: wikiUrl(sourceNamespace as Parameters<typeof wikiUrl>[0], source.title),
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

  async getContributions(input: {
    readonly profileId: string;
    readonly accountId?: string | null;
    readonly cursor?: string;
    readonly limit?: string | number;
  }): Promise<WikiContributionResponse> {
    const profileId = this.parseBigIntId(input.profileId, 'profileId');
    const profile = await this.prisma.wikiProfile.findUnique({
      where: { id: profileId },
      select: { id: true, username: true, displayName: true, status: true }
    });
    if (!profile || profile.status !== 'active') throw new NotFoundException('Wiki profile not found.');
    const limit = Math.min(Math.max(Number(input.limit ?? 30) || 30, 1), 100);
    const cursor = input.cursor ? this.parseBigIntId(input.cursor, 'cursor') : null;
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
        pageId: page.id.toString(),
        revisionId: change.revisionId?.toString() ?? null,
        changeType: change.changeType,
        title: page.displayTitle,
        namespace,
        routePath: wikiUrl(namespace as Parameters<typeof wikiUrl>[0], page.title),
        summary: change.summary,
        isMinor: change.isMinor,
        createdAt: change.createdAt.toISOString()
      });
      if (items.length >= limit) break;
    }
    const mayHaveMore = changes.length > 0 && (items.length >= limit || changes.length >= Math.min(limit * 4 + 1, 401));
    return {
      profile: {
        id: profile.id.toString(),
        username: profile.username,
        displayName: profile.displayName
      },
      items,
      nextCursor: mayHaveMore ? lastScannedId?.toString() ?? null : null
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

  async search(input: {
    readonly q?: string;
    readonly namespace?: string;
    readonly limit?: string | number;
    readonly accountId?: string | null;
  }): Promise<WikiSearchResult[]> {
    const query = input.q?.trim() ?? '';
    if (!query) {
      return [];
    }
    const limit = Math.min(Math.max(Number(input.limit ?? 20) || 20, 1), 50);
    const namespace = input.namespace?.trim()
      ? await this.prisma.wikiNamespace.findUnique({ where: { code: input.namespace.trim() } })
      : null;
    if (input.namespace?.trim() && !namespace) {
      return [];
    }

    const contentMatches = await this.prisma.wikiPageRevision.findMany({
      where: {
        visibility: 'public',
        contentRaw: { contains: query }
      },
      select: { pageId: true },
      orderBy: [{ createdAt: 'desc' }],
      take: 200
    });
    const contentPageIds = [...new Set(contentMatches.map((match) => match.pageId))];
    const pages = await this.prisma.wikiPage.findMany({
      where: {
        namespaceId: namespace?.id,
        status: { in: ['normal', 'active', 'published'] },
        OR: [
          { title: { contains: query } },
          { displayTitle: { contains: query } },
          { slug: { contains: slugifyTitle(query) } },
          { localPath: { contains: slugifyTitle(query) } },
          ...(contentPageIds.length > 0 ? [{ id: { in: contentPageIds } }] : [])
        ]
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: Math.max(limit * 4, 50)
    });
    const namespaceIds = [...new Set(pages.map((page) => page.namespaceId))];
    const namespaces = namespaceIds.length > 0
      ? await this.prisma.wikiNamespace.findMany({
          where: { id: { in: namespaceIds } },
          select: { id: true, code: true }
        })
      : [];
    const namespaceById = new Map(namespaces.map((item) => [item.id, item.code]));
    const results: WikiSearchResult[] = [];
    for (const page of pages) {
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
        continue;
      }
      const matchesPage = [page.title, page.displayTitle, page.slug, page.localPath].some((value) =>
        value.toLocaleLowerCase().includes(query.toLocaleLowerCase())
      );
      const matchesContent = revision.contentRaw.toLocaleLowerCase().includes(query.toLocaleLowerCase());
      if (!matchesPage && !matchesContent) {
        continue;
      }
      try {
        await this.wikiPermissions.assertCanReadPage({
          accountId: input.accountId ?? null,
          page,
          revision
        });
      } catch {
        continue;
      }
      const namespaceCode = namespaceById.get(page.namespaceId) ?? 'main';
      results.push({
        pageId: page.id.toString(),
        namespace: namespaceCode,
        title: page.title,
        displayTitle: page.displayTitle,
        routePath: wikiUrl(namespaceCode as Parameters<typeof wikiUrl>[0], page.title),
        snippet: makeSearchSnippet(revision.contentRaw, query),
        updatedAt: page.updatedAt.toISOString()
      });
      if (results.length >= limit) {
        break;
      }
    }
    return results;
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
    await this.wikiLinks?.replaceForRevision(this.prisma, page.id, revision.id, parsed.links).catch(() => undefined);
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
    const cache = await this.prisma.wikiPageRenderCache.findUnique({
      where: {
        revisionId_rendererVersion: {
          revisionId: revision.id,
          rendererVersion: WIKI_RENDERER_VERSION
        }
      }
    });
    const files = cache ? {} : await this.findRenderableFiles(parsed.ast);
    const html = cache?.html ?? renderDocument(parsed.ast, {
      files,
      internalLinkBasePath: serverWiki ? `/server/${encodeURIComponent(serverWiki.context.slug)}` : undefined,
    });
    if (!cache) {
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
        orderBy: [{ localPath: 'asc' }, { id: 'asc' }],
        take: 100
      })
    ]);
    const navigationPages = [...pages].sort((left, right) => {
      const leftRoot = serverWikiRelativePath(serverWiki.slug, left.localPath) ? 0 : -1;
      const rightRoot = serverWikiRelativePath(serverWiki.slug, right.localPath) ? 0 : -1;
      return leftRoot - rightRoot || left.localPath.localeCompare(right.localPath, 'ko');
    });
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
        navigation: navigationPages.map((item) => {
          const relativePath = serverWikiRelativePath(serverWiki.slug, item.localPath);
          const hasChildren = navigationPages.some((candidate) => {
            if (candidate.id === item.id) return false;
            const candidatePath = serverWikiRelativePath(serverWiki.slug, candidate.localPath);
            return relativePath ? candidatePath.startsWith(`${relativePath}/`) : Boolean(candidatePath);
          });
          return {
            id: item.id.toString(),
            title: item.displayTitle,
            path: buildServerWikiPagePath(serverWiki.slug, item.localPath),
            current: item.id === currentPageId,
            depth: serverWikiNavigationDepth(serverWiki.slug, item.localPath),
            hasChildren
          };
        })
      }
    };
  }

  private async findRenderableFiles(ast: AstNode[]) {
    const fileNames = Array.from(collectFileNames(ast));
    if (fileNames.length === 0) {
      return {};
    }
    const files = await this.prisma.uploadedFile.findMany({
      where: {
        filename: { in: fileNames },
        status: 'active'
      }
    });
    return Object.fromEntries(
      files.map((file) => [
        file.filename,
        {
          url: file.publicPath,
          mimeType: file.mimeType,
          originalName: file.originalName ?? file.filename
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
}

export function buildServerWikiPagePath(serverSlug: string, localPath: string): string {
  const normalizedSlug = slugifyTitle(serverSlug);
  const normalizedPath = slugifyTitle(localPath);
  const relativePath = normalizedPath === normalizedSlug
    ? ''
    : normalizedPath.startsWith(`${normalizedSlug}/`)
      ? normalizedPath.slice(normalizedSlug.length + 1)
      : normalizedPath;
  const encodedSlug = normalizedSlug.split('/').map(encodeURIComponent).join('/');
  if (!relativePath) return `/server/${encodedSlug}`;
  const encodedRelative = relativePath.split('/').map(encodeURIComponent).join('/');
  return `/server/${encodedSlug}/${encodedRelative}`;
}

export function serverWikiNavigationDepth(serverSlug: string, localPath: string): number {
  const relativePath = serverWikiRelativePath(serverSlug, localPath);
  return relativePath ? Math.max(0, relativePath.split('/').filter(Boolean).length - 1) : 0;
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

function collectFileNames(ast: AstNode[], output = new Set<string>()): Set<string> {
  for (const node of ast) {
    if (node.type === 'file') {
      output.add(node.fileName);
    } else if (node.type === 'folding') {
      collectFileNames(node.children, output);
    }
  }
  return output;
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
