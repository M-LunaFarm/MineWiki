import { BadRequestException, Injectable } from '@nestjs/common';
import { slugifyTitle, wikiUrl } from '@minewiki/wiki-core';
import { PrismaService } from '../common/prisma.service';

export interface WikiRoutePage {
  readonly id: bigint;
  readonly namespaceId: number;
  readonly spaceId: bigint;
  readonly title: string;
  readonly localPath: string;
}

export class WikiRoutePathBatch {
  constructor(
    private readonly namespaceById: ReadonlyMap<number, string>,
    private readonly serverWikiBySpaceId: ReadonlyMap<bigint, { slug: string; siteSlug: string }>
  ) {}

  namespace(page: Pick<WikiRoutePage, 'namespaceId'>, fallback = 'main'): string {
    return this.namespaceById.get(page.namespaceId) ?? fallback;
  }

  serverSlug(page: Pick<WikiRoutePage, 'spaceId'>): string | undefined {
    return this.serverWikiBySpaceId.get(page.spaceId)?.siteSlug;
  }

  serverWiki(page: Pick<WikiRoutePage, 'spaceId'>): { slug: string; siteSlug: string } | undefined {
    return this.serverWikiBySpaceId.get(page.spaceId);
  }

  routePath(page: WikiRoutePage, fallbackNamespace = 'main'): string {
    const namespace = this.namespace(page, fallbackNamespace);
    if (namespace === 'server') {
      const serverWiki = this.serverWikiBySpaceId.get(page.spaceId);
      if (serverWiki) return buildCanonicalServerWikiPath(
        serverWiki.siteSlug,
        page.localPath,
        serverWiki.slug,
        '/serverWiki'
      );
    }
    return wikiUrl(namespace as Parameters<typeof wikiUrl>[0], page.title);
  }

  targetRoutePath(namespace: string, targetPath: string, contextPage?: Pick<WikiRoutePage, 'spaceId'>): string {
    if (namespace === 'server' && contextPage) {
      const serverWiki = this.serverWikiBySpaceId.get(contextPage.spaceId);
      if (serverWiki) return buildCanonicalServerWikiPath(
        serverWiki.siteSlug,
        targetPath,
        serverWiki.slug,
        '/serverWiki'
      );
    }
    return wikiUrl(namespace as Parameters<typeof wikiUrl>[0], targetPath);
  }
}

@Injectable()
export class WikiRoutePathResolver {
  constructor(private readonly prisma: PrismaService) {}

  async preload(
    pages: readonly WikiRoutePage[],
    knownNamespaces: ReadonlyMap<number, string> = new Map()
  ): Promise<WikiRoutePathBatch> {
    const namespaceById = new Map(knownNamespaces);
    const missingNamespaceIds = [...new Set(pages
      .map((page) => page.namespaceId)
      .filter((namespaceId) => !namespaceById.has(namespaceId)))];
    if (missingNamespaceIds.length > 0) {
      const namespaces = await this.prisma.wikiNamespace.findMany({
        where: { id: { in: missingNamespaceIds } },
        select: { id: true, code: true }
      });
      for (const namespace of namespaces) namespaceById.set(namespace.id, namespace.code);
    }

    const serverSpaceIds = [...new Set(pages
      .filter((page) => namespaceById.get(page.namespaceId) === 'server')
      .map((page) => page.spaceId))];
    const serverWikis = serverSpaceIds.length > 0
      ? await this.prisma.serverWiki.findMany({
          where: { spaceId: { in: serverSpaceIds }, status: { not: 'disabled' } },
          select: { spaceId: true, slug: true, siteSlug: true }
        })
      : [];
    return new WikiRoutePathBatch(
      namespaceById,
      new Map(serverWikis.map((wiki) => [wiki.spaceId, {
        slug: wiki.slug,
        siteSlug: wiki.siteSlug ?? wiki.slug
      }]))
    );
  }
}

export function buildCanonicalServerWikiPath(
  serverSlug: string,
  localPath: string,
  contentRootSlug = serverSlug,
  routePrefix: '/server' | '/serverWiki' = '/server'
): string {
  const normalizedSlug = slugifyTitle(contentRootSlug);
  const normalizedRouteSlug = slugifyTitle(serverSlug);
  const normalizedPath = slugifyTitle(localPath);
  const relativePath = normalizedPath === normalizedSlug
    ? ''
    : normalizedPath.startsWith(`${normalizedSlug}/`)
      ? normalizedPath.slice(normalizedSlug.length + 1)
      : normalizedPath;
  const encodedSlug = normalizedRouteSlug.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const encodedRelativePath = relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return encodedRelativePath ? `${routePrefix}/${encodedSlug}/${encodedRelativePath}` : `${routePrefix}/${encodedSlug}`;
}

export function buildCanonicalServerWikiToolPath(
  serverSlug: string,
  localPath: string,
  tool: string,
  contentRootSlug = serverSlug,
  routePrefix: '/server' | '/serverWiki' = '/server'
): string {
  if (!/^[a-z][a-z0-9-]{1,31}$/u.test(tool)) throw new BadRequestException('Invalid server wiki tool.');
  const rootPath = buildCanonicalServerWikiPath(serverSlug, contentRootSlug, contentRootSlug, routePrefix);
  const pagePath = buildCanonicalServerWikiPath(serverSlug, localPath, contentRootSlug, routePrefix);
  return `${rootPath}/_tools/${tool}${pagePath.slice(rootPath.length)}`;
}
