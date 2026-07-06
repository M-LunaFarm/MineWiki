import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { hashContent, parseMarkup, renderDocument, WIKI_RENDERER_VERSION } from '@minewiki/wiki-core';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';

const ALLOWED_PROTECTION_LEVELS = new Set([
  'open',
  'login_required',
  'review_required',
  'autoconfirmed_only',
  'trusted_only',
  'official_only',
  'owner_only',
  'admin_only',
  'locked'
]);
const ALLOWED_REVISION_VISIBILITIES = new Set(['public', 'hidden', 'deleted', 'private']);

export interface WikiAdminRecentChange {
  readonly id: string;
  readonly pageId: string | null;
  readonly revisionId: string | null;
  readonly actorId: string | null;
  readonly changeType: string;
  readonly title: string;
  readonly namespaceCode: string;
  readonly summary: string | null;
  readonly createdAt: string;
}

export interface WikiAdminPageSummary {
  readonly id: string;
  readonly namespaceId: number;
  readonly spaceId: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly protectionLevel: string;
  readonly status: string;
  readonly currentRevisionId: string | null;
  readonly updatedAt: string;
}

@Injectable()
export class WikiAdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly events?: BusinessEventService
  ) {}

  async getRecent(): Promise<WikiAdminRecentChange[]> {
    const changes = await this.prisma.wikiRecentChange.findMany({
      orderBy: [{ createdAt: 'desc' }],
      take: 100
    });
    return changes.map((change) => ({
      id: change.id.toString(),
      pageId: change.pageId?.toString() ?? null,
      revisionId: change.revisionId?.toString() ?? null,
      actorId: change.actorId?.toString() ?? null,
      changeType: change.changeType,
      title: change.title,
      namespaceCode: change.namespaceCode,
      summary: change.summary,
      createdAt: change.createdAt.toISOString()
    }));
  }

  async getPages(status?: string): Promise<WikiAdminPageSummary[]> {
    const pages = await this.prisma.wikiPage.findMany({
      where: status?.trim() ? { status: status.trim() } : undefined,
      orderBy: [{ updatedAt: 'desc' }],
      take: 100
    });
    return pages.map(toPageSummary);
  }

  async updateProtection(input: {
    readonly pageId: string;
    readonly protectionLevel?: string;
    readonly actorProfileId: bigint | null;
    readonly reason?: string | null;
  }): Promise<WikiAdminPageSummary> {
    const pageId = this.parseBigIntId(input.pageId, 'pageId');
    const protectionLevel = input.protectionLevel?.trim();
    if (!protectionLevel || !ALLOWED_PROTECTION_LEVELS.has(protectionLevel)) {
      throw new BadRequestException('Invalid wiki protection level.');
    }
    const page = await this.prisma.wikiPage.findUnique({ where: { id: pageId } });
    if (!page) {
      throw new NotFoundException('Wiki page not found.');
    }
    const updated = await this.prisma.wikiPage.update({
      where: { id: pageId },
      data: {
        protectionLevel,
        updatedAt: new Date()
      }
    });
    const namespace = await this.namespaceCode(updated.namespaceId);
    await this.insertRecentChange({
      pageId: updated.id,
      revisionId: updated.currentRevisionId,
      actorId: input.actorProfileId,
      changeType: 'protect',
      title: updated.title,
      namespaceCode: namespace,
      summary: input.reason?.trim() || `보호 수준 변경: ${page.protectionLevel} -> ${protectionLevel}`
    });
    await this.auditAdmin('wiki.protect', {
      actorProfileId: input.actorProfileId,
      pageId: updated.id,
      revisionId: updated.currentRevisionId,
      metadata: {
        previousProtectionLevel: page.protectionLevel,
        protectionLevel,
        reason: input.reason?.trim() || null
      }
    });
    return toPageSummary(updated);
  }

  async updateRevisionVisibility(input: {
    readonly revisionId: string;
    readonly visibility?: string;
    readonly actorProfileId: bigint | null;
    readonly reason?: string | null;
  }): Promise<{ revisionId: string; visibility: string }> {
    const revisionId = this.parseBigIntId(input.revisionId, 'revisionId');
    const visibility = input.visibility?.trim();
    if (!visibility || !ALLOWED_REVISION_VISIBILITIES.has(visibility)) {
      throw new BadRequestException('Invalid wiki revision visibility.');
    }
    const revision = await this.prisma.wikiPageRevision.findUnique({ where: { id: revisionId } });
    if (!revision) {
      throw new NotFoundException('Wiki revision not found.');
    }
    const updated = await this.prisma.wikiPageRevision.update({
      where: { id: revisionId },
      data: { visibility }
    });
    const page = await this.prisma.wikiPage.findUnique({ where: { id: revision.pageId } });
    if (page?.currentRevisionId === revisionId && visibility !== 'public') {
      const fallback = await this.prisma.wikiPageRevision.findFirst({
        where: {
          pageId: revision.pageId,
          visibility: 'public',
          id: { not: revisionId }
        },
        orderBy: [{ revisionNo: 'desc' }]
      });
      await this.prisma.wikiPage.update({
        where: { id: revision.pageId },
        data: {
          currentRevisionId: fallback?.id ?? null,
          updatedAt: new Date()
        }
      });
    }
    if (page) {
      await this.insertRecentChange({
        pageId: page.id,
        revisionId: updated.id,
        actorId: input.actorProfileId,
        changeType: 'revision_visibility',
        title: page.title,
        namespaceCode: await this.namespaceCode(page.namespaceId),
        summary: input.reason?.trim() || `리비전 표시 상태 변경: ${visibility}`
      });
      await this.auditAdmin('wiki.revision_visibility', {
        actorProfileId: input.actorProfileId,
        pageId: page.id,
        revisionId: updated.id,
        metadata: {
          visibility,
          reason: input.reason?.trim() || null
        }
      });
    }
    return { revisionId: updated.id.toString(), visibility: updated.visibility };
  }

  async rollback(input: {
    readonly pageId: string;
    readonly revisionId?: string;
    readonly actorProfileId: bigint;
    readonly reason?: string | null;
  }): Promise<{ pageId: string; revisionId: string; revisionNo: number }> {
    const pageId = this.parseBigIntId(input.pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: pageId } });
    if (!page || page.status === 'deleted') {
      throw new NotFoundException('Wiki page not found.');
    }
    const source = input.revisionId
      ? await this.prisma.wikiPageRevision.findUnique({
          where: { id: this.parseBigIntId(input.revisionId, 'revisionId') }
        })
      : await this.prisma.wikiPageRevision.findFirst({
          where: { pageId, visibility: 'public' },
          orderBy: [{ revisionNo: 'asc' }]
        });
    if (!source || source.pageId !== page.id || source.visibility !== 'public') {
      throw new NotFoundException('Rollback source revision not found.');
    }
    const latest = await this.prisma.wikiPageRevision.findFirst({
      where: { pageId, visibility: 'public' },
      orderBy: [{ revisionNo: 'desc' }]
    });
    const now = new Date();
    const parsed = parseMarkup(source.contentRaw);
    if (parsed.blockingErrors.length > 0) {
      throw new BadRequestException('Rollback source contains blocking wiki markup.');
    }
    const revision = await this.prisma.wikiPageRevision.create({
      data: {
        pageId: page.id,
        revisionNo: latest ? latest.revisionNo + 1 : 1,
        parentRevisionId: latest?.id ?? null,
        contentRaw: source.contentRaw,
        contentAst: JSON.parse(JSON.stringify(parsed.ast)),
        contentHash: hashContent(source.contentRaw),
        contentSize: Buffer.byteLength(source.contentRaw, 'utf8'),
        syntaxVersion: source.syntaxVersion,
        editSummary: input.reason?.trim() || `관리자 롤백: r${source.revisionNo}`,
        isMinor: false,
        editTags: null,
        createdBy: input.actorProfileId,
        actorType: 'user',
        actorUserId: input.actorProfileId,
        actorIp: null,
        actorIpText: null,
        actorIpHash: null,
        createdAt: now,
        visibility: 'public'
      }
    });
    await this.prisma.wikiPageRenderCache.create({
      data: {
        pageId: page.id,
        revisionId: revision.id,
        rendererVersion: WIKI_RENDERER_VERSION,
        html: renderDocument(parsed.ast),
        createdAt: now
      }
    });
    await this.prisma.wikiPage.update({
      where: { id: page.id },
      data: {
        currentRevisionId: revision.id,
        updatedAt: now
      }
    });
    await this.insertRecentChange({
      pageId: page.id,
      revisionId: revision.id,
      actorId: input.actorProfileId,
      changeType: 'rollback',
      title: page.title,
      namespaceCode: await this.namespaceCode(page.namespaceId),
      summary: revision.editSummary
    });
    await this.auditAdmin('wiki.rollback', {
      actorProfileId: input.actorProfileId,
      pageId: page.id,
      revisionId: revision.id,
      metadata: {
        sourceRevisionId: source.id.toString(),
        sourceRevisionNo: source.revisionNo,
        reason: input.reason?.trim() || null
      }
    });
    return { pageId: page.id.toString(), revisionId: revision.id.toString(), revisionNo: revision.revisionNo };
  }

  async setPageStatus(input: {
    readonly pageId: string;
    readonly status: 'deleted' | 'normal';
    readonly actorProfileId: bigint | null;
    readonly reason?: string | null;
  }): Promise<WikiAdminPageSummary> {
    const pageId = this.parseBigIntId(input.pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: pageId } });
    if (!page) {
      throw new NotFoundException('Wiki page not found.');
    }
    const updated = await this.prisma.wikiPage.update({
      where: { id: pageId },
      data: {
        status: input.status,
        updatedAt: new Date()
      }
    });
    await this.insertRecentChange({
      pageId: updated.id,
      revisionId: updated.currentRevisionId,
      actorId: input.actorProfileId,
      changeType: input.status === 'deleted' ? 'delete' : 'restore',
      title: updated.title,
      namespaceCode: await this.namespaceCode(updated.namespaceId),
      summary: input.reason?.trim() || (input.status === 'deleted' ? '관리자 삭제' : '관리자 복구')
    });
    await this.auditAdmin(input.status === 'deleted' ? 'wiki.delete' : 'wiki.restore', {
      actorProfileId: input.actorProfileId,
      pageId: updated.id,
      revisionId: updated.currentRevisionId,
      metadata: {
        previousStatus: page.status,
        status: input.status,
        reason: input.reason?.trim() || null
      }
    });
    return toPageSummary(updated);
  }

  private async insertRecentChange(input: {
    readonly pageId: bigint;
    readonly revisionId: bigint | null;
    readonly actorId: bigint | null;
    readonly changeType: string;
    readonly title: string;
    readonly namespaceCode: string;
    readonly summary?: string | null;
  }): Promise<void> {
    await this.prisma.wikiRecentChange.create({
      data: {
        pageId: input.pageId,
        revisionId: input.revisionId,
        actorId: input.actorId,
        changeType: input.changeType,
        title: input.title,
        namespaceCode: input.namespaceCode,
        summary: input.summary ?? null,
        isMinor: false,
        createdAt: new Date()
      }
    });
  }

  private async auditAdmin(
    action: string,
    input: {
      readonly actorProfileId: bigint | null;
      readonly pageId: bigint;
      readonly revisionId?: bigint | null;
      readonly metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    await this.events?.audit(action, {
      category: 'wiki',
      actorProfileId: input.actorProfileId,
      subjectType: 'wiki_page',
      subjectId: input.pageId,
      metadata: {
        pageId: input.pageId,
        revisionId: input.revisionId ?? null,
        ...input.metadata
      }
    });
  }

  private async namespaceCode(namespaceId: number): Promise<string> {
    const namespace = await this.prisma.wikiNamespace.findUnique({ where: { id: namespaceId } });
    return namespace?.code ?? 'main';
  }

  private parseBigIntId(value: string, label: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException(`${label} must be an unsigned integer.`);
    }
    return BigInt(value);
  }
}

function toPageSummary(page: {
  id: bigint;
  namespaceId: number;
  spaceId: bigint;
  title: string;
  displayTitle: string;
  protectionLevel: string;
  status: string;
  currentRevisionId: bigint | null;
  updatedAt: Date;
}): WikiAdminPageSummary {
  return {
    id: page.id.toString(),
    namespaceId: page.namespaceId,
    spaceId: page.spaceId.toString(),
    title: page.title,
    displayTitle: page.displayTitle,
    protectionLevel: page.protectionLevel,
    status: page.status,
    currentRevisionId: page.currentRevisionId?.toString() ?? null,
    updatedAt: page.updatedAt.toISOString()
  };
}
