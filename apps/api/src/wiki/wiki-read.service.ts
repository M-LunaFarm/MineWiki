import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { parseMarkup, renderDocument, resolveWikiPath, slugifyTitle } from '@minewiki/wiki-core';
import { PrismaService } from '../common/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

  async getPage(namespaceCode: string, title: string): Promise<WikiPageResponse> {
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
    if (!page || page.status === 'deleted' || page.status === 'hidden') {
      throw new NotFoundException('Wiki page not found.');
    }
    return this.renderPage(namespace.code, page);
  }

  getPageByPath(path: string): Promise<WikiPageResponse> {
    const resolved = resolveWikiPath(path);
    return this.getPage(resolved.namespace, resolved.title);
  }

  async getRevisions(pageId: string): Promise<WikiRevisionSummary[]> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
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

    const cache = await this.prisma.wikiPageRenderCache.findFirst({
      where: {
        revisionId: revision.id
      },
      orderBy: [{ createdAt: 'desc' }]
    });
    const parsed = parseMarkup(revision.contentRaw);
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
      categories: parsed.categories
    };
  }

  private parseBigIntId(value: string, label: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException(`${label} must be an unsigned integer.`);
    }
    return BigInt(value);
  }
}
