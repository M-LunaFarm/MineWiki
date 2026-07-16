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
    private readonly serverSlugBySpaceId: ReadonlyMap<bigint, string>
  ) {}

  namespace(page: Pick<WikiRoutePage, 'namespaceId'>, fallback = 'main'): string {
    return this.namespaceById.get(page.namespaceId) ?? fallback;
  }

  serverSlug(page: Pick<WikiRoutePage, 'spaceId'>): string | undefined {
    return this.serverSlugBySpaceId.get(page.spaceId);
  }

  routePath(page: WikiRoutePage, fallbackNamespace = 'main'): string {
    const namespace = this.namespace(page, fallbackNamespace);
    if (namespace === 'server') {
      const serverSlug = this.serverSlugBySpaceId.get(page.spaceId);
      if (serverSlug) return buildCanonicalServerWikiPath(serverSlug, page.localPath);
    }
    return wikiUrl(namespace as Parameters<typeof wikiUrl>[0], page.title);
  }

  targetRoutePath(namespace: string, targetPath: string, contextPage?: Pick<WikiRoutePage, 'spaceId'>): string {
    if (namespace === 'server' && contextPage) {
      const serverSlug = this.serverSlug(contextPage);
      if (serverSlug) return buildCanonicalServerWikiPath(serverSlug, targetPath);
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
          select: { spaceId: true, slug: true }
        })
      : [];
    return new WikiRoutePathBatch(
      namespaceById,
      new Map(serverWikis.map((wiki) => [wiki.spaceId, wiki.slug]))
    );
  }
}

export function buildCanonicalServerWikiPath(serverSlug: string, localPath: string): string {
  const normalizedSlug = slugifyTitle(serverSlug);
  const normalizedPath = slugifyTitle(localPath);
  const relativePath = normalizedPath === normalizedSlug
    ? ''
    : normalizedPath.startsWith(`${normalizedSlug}/`)
      ? normalizedPath.slice(normalizedSlug.length + 1)
      : normalizedPath;
  const encodedSlug = normalizedSlug.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const encodedRelativePath = relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return encodedRelativePath ? `/server/${encodedSlug}/${encodedRelativePath}` : `/server/${encodedSlug}`;
}

export function buildCanonicalServerWikiToolPath(serverSlug: string, localPath: string, tool: string): string {
  if (!/^[a-z][a-z0-9-]{1,31}$/u.test(tool)) throw new BadRequestException('Invalid server wiki tool.');
  const rootPath = buildCanonicalServerWikiPath(serverSlug, serverSlug);
  const pagePath = buildCanonicalServerWikiPath(serverSlug, localPath);
  return `${rootPath}/_tools/${tool}${pagePath.slice(rootPath.length)}`;
}
