import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { parseMarkup, renderDocument, resolveWikiPath, slugifyTitle } from '@minewiki/wiki-core';
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
  readonly serverDirectoryPath?: string | null;
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

@Injectable()
export class WikiReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiPermissions: WikiPermissionService
  ) {}

  async getPage(namespaceCode: string, title: string, accountId?: string | null): Promise<WikiPageResponse> {
    const normalizedNamespace = namespaceCode.trim() || 'main';
    const normalizedTitle = title.trim() || '대문';
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
    return this.renderPage(namespace.code, page, accountId ?? null);
  }

  getPageByPath(path: string, accountId?: string | null): Promise<WikiPageResponse> {
    const resolved = resolveWikiPath(path);
    return this.getPage(resolved.namespace, resolved.title, accountId ?? null);
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

  private async renderPage(namespace: string, page: {
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
  }, accountId: string | null): Promise<WikiPageResponse> {
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

    const cache = await this.prisma.wikiPageRenderCache.findFirst({
      where: {
        revisionId: revision.id
      },
      orderBy: [{ createdAt: 'desc' }]
    });
    const parsed = parseMarkup(revision.contentRaw);
    const serverDirectoryPath = await this.findServerDirectoryPath(namespace, page.spaceId);
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
      html: cache?.html ?? renderDocument(parsed.ast),
      links: parsed.links,
      categories: parsed.categories,
      serverDirectoryPath
    };
  }

  private async findServerDirectoryPath(namespace: string, spaceId: bigint): Promise<string | null> {
    if (namespace !== 'server') {
      return null;
    }
    const serverWiki = await this.prisma.serverWiki.findFirst({
      where: { spaceId },
      select: { voteServerId: true }
    });
    if (!serverWiki?.voteServerId) {
      return null;
    }
    const server = await this.prisma.server.findUnique({
      where: { id: serverWiki.voteServerId },
      select: { id: true, shortCode: true }
    });
    if (!server) {
      return null;
    }
    return `/servers/${server.shortCode?.trim() || server.id}`;
  }

  private parseBigIntId(value: string, label: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException(`${label} must be an unsigned integer.`);
    }
    return BigInt(value);
  }
}
