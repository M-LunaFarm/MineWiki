import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
    readonly layout: 'docs';
    readonly navigation: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly path: string;
      readonly current: boolean;
    }>;
  } | null;
}

export interface WikiRevisionSummary {
  readonly id: string;
  readonly revisionNo: number;
  readonly editSummary: string | null;
  readonly isMinor: boolean;
  readonly createdBy: string | null;
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

@Injectable()
export class WikiReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiPermissions: WikiPermissionService
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
    return revisions.map((revision) => ({
      id: revision.id.toString(),
      revisionNo: revision.revisionNo,
      editSummary: revision.editSummary,
      isMinor: revision.isMinor,
      createdBy: revision.createdBy?.toString() ?? null,
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
    if (parsed.redirectTarget && options.followRedirects) {
      const target = parseLinkTarget(parsed.redirectTarget);
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

    const cache = await this.prisma.wikiPageRenderCache.findUnique({
      where: {
        revisionId_rendererVersion: {
          revisionId: revision.id,
          rendererVersion: WIKI_RENDERER_VERSION
        }
      }
    });
    const files = cache ? {} : await this.findRenderableFiles(parsed.ast);
    const html = cache?.html ?? renderDocument(parsed.ast, { files });
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
    const serverWiki = await this.findServerWikiContext(namespace, page.spaceId, page.id);
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
        genres: true
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
        where: { spaceId, status: { not: 'deleted' } },
        select: { id: true, localPath: true, displayTitle: true },
        orderBy: [{ id: 'asc' }],
        take: 100
      })
    ]);
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
        layout: 'docs' as const,
        navigation: pages.map((item) => ({
          id: item.id.toString(),
          title: item.displayTitle,
          path:
            item.localPath === serverWiki.slug
              ? `/server/${serverWiki.slug}`
              : `/server/${serverWiki.slug}/${item.localPath}`,
          current: item.id === currentPageId
        }))
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
