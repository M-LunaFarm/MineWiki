import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional
} from '@nestjs/common';
import { hashContent, parseMarkup, renderDocument, slugifyTitle, WIKI_RENDERER_VERSION } from '@minewiki/wiki-core';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';

type ChangeType = 'create' | 'edit';

export interface WikiPageMutationRequest {
  readonly namespace?: string;
  readonly title?: string;
  readonly displayTitle?: string;
  readonly spaceId?: string;
  readonly pageType?: string;
  readonly contentRaw?: string;
  readonly editSummary?: string;
  readonly isMinor?: boolean;
  readonly baseRevisionId?: string;
}

export interface WikiSectionMutationRequest {
  readonly heading?: string;
  readonly contentRaw?: string;
  readonly editSummary?: string;
  readonly isMinor?: boolean;
  readonly baseRevisionId?: string;
}

export interface WikiMutationResponse {
  readonly pageId: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly namespace: string;
  readonly title: string;
  readonly slug: string;
}

export interface WikiRevisionResponse {
  readonly id: string;
  readonly pageId: string;
  readonly revisionNo: number;
  readonly parentRevisionId: string | null;
  readonly contentRaw: string;
  readonly contentHash: string;
  readonly contentSize: number;
  readonly syntaxVersion: string;
  readonly editSummary: string | null;
  readonly isMinor: boolean;
  readonly createdBy: string | null;
  readonly actorUserId: string | null;
  readonly createdAt: string;
  readonly visibility: string;
}

export interface WikiRevisionDiffResponse {
  readonly left: WikiRevisionResponse;
  readonly right: WikiRevisionResponse;
  readonly hunks: Array<{
    readonly type: 'context' | 'added' | 'removed';
    readonly line: string;
    readonly leftLine: number | null;
    readonly rightLine: number | null;
  }>;
}

export interface WikiPreviewResponse {
  readonly html: string;
  readonly links: string[];
  readonly categories: string[];
  readonly errors: string[];
  readonly blockingErrors: string[];
}

@Injectable()
export class WikiEditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiProfiles: WikiProfileService,
    private readonly wikiPermissions: WikiPermissionService,
    @Optional() private readonly events?: BusinessEventService
  ) {}

  async createPage(session: SessionPayload, request: WikiPageMutationRequest): Promise<WikiMutationResponse> {
    const namespaceCode = this.cleanNamespace(request.namespace);
    const title = this.requiredString(request.title, 'title');
    const contentRaw = this.requiredString(request.contentRaw, 'contentRaw');
    const namespace = await this.prisma.wikiNamespace.findUnique({
      where: { code: namespaceCode }
    });
    if (!namespace) {
      throw new NotFoundException('Wiki namespace not found.');
    }
    const spaceId = request.spaceId
      ? this.parseBigIntId(request.spaceId, 'spaceId')
      : await this.findDefaultSpaceId(namespaceCode);
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const slug = slugifyTitle(title);
    const now = new Date();
    await this.wikiPermissions.assertCanCreatePage({
      actor: this.wikiPermissions.actorFromSession(session, actor),
      namespaceCode,
      spaceId,
      title,
      pageType: this.cleanOptional(request.pageType) ?? 'article'
    });

    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.wikiPage.findUnique({
        where: {
          namespaceId_slug: {
            namespaceId: namespace.id,
            slug
          }
        }
      });
      if (existing) {
        throw new ConflictException('Wiki page already exists.');
      }
      const page = await tx.wikiPage.create({
        data: {
          namespaceId: namespace.id,
          spaceId,
          localPath: slug,
          slug,
          title,
          displayTitle: this.cleanOptional(request.displayTitle) ?? title,
          pageType: this.cleanOptional(request.pageType) ?? 'article',
          protectionLevel: 'open',
          status: 'normal',
          createdBy: actor.id,
          createdAt: now,
          updatedAt: now
        }
      });
      const revision = await this.createRevision(tx, {
        pageId: page.id,
        revisionNo: 1,
        parentRevisionId: null,
        contentRaw,
        editSummary: this.cleanOptional(request.editSummary),
        isMinor: Boolean(request.isMinor),
        actorId: actor.id,
        createdAt: now
      });
      await tx.wikiPage.update({
        where: { id: page.id },
        data: {
          currentRevisionId: revision.id,
          updatedAt: now
        }
      });
      await this.insertRecentChange(tx, {
        pageId: page.id,
        revisionId: revision.id,
        actorId: actor.id,
        changeType: 'create',
        title: page.title,
        namespaceCode,
        summary: revision.editSummary,
        isMinor: revision.isMinor,
        createdAt: now
      });
      return {
        pageId: page.id.toString(),
        revisionId: revision.id.toString(),
        revisionNo: revision.revisionNo,
        namespace: namespaceCode,
        title: page.title,
        slug: page.slug
      };
    });
    await this.events?.audit('wiki.create', {
      category: 'wiki',
      actorAccountId: session.userId,
      actorProfileId: actor.id,
      subjectType: 'wiki_page',
      subjectId: result.pageId,
      metadata: {
        namespace: result.namespace,
        title: result.title,
        revisionId: result.revisionId,
        revisionNo: result.revisionNo
      }
    });
    return result;
  }

  async updatePage(session: SessionPayload, pageId: string, request: WikiPageMutationRequest): Promise<WikiMutationResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const contentRaw = this.requiredString(request.contentRaw, 'contentRaw');
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const page = await tx.wikiPage.findUnique({ where: { id: parsedPageId } });
      if (!page || page.status === 'deleted') {
        throw new NotFoundException('Wiki page not found.');
      }
      const namespace = await tx.wikiNamespace.findUnique({ where: { id: page.namespaceId } });
      if (!namespace) {
        throw new NotFoundException('Wiki namespace not found.');
      }
      await this.wikiPermissions.assertCanEditPage({
        actor: this.wikiPermissions.actorFromSession(session, actor),
        page,
        store: tx
      });
      if (request.baseRevisionId && page.currentRevisionId?.toString() !== request.baseRevisionId) {
        throw new ConflictException('Base revision does not match current revision.');
      }
      const latest = await this.findLatestRevision(tx, page.id);
      const revision = await this.createRevision(tx, {
        pageId: page.id,
        revisionNo: latest ? latest.revisionNo + 1 : 1,
        parentRevisionId: latest?.id ?? null,
        contentRaw,
        editSummary: this.cleanOptional(request.editSummary),
        isMinor: Boolean(request.isMinor),
        actorId: actor.id,
        createdAt: now
      });
      await tx.wikiPage.update({
        where: { id: page.id },
        data: {
          currentRevisionId: revision.id,
          updatedAt: now
        }
      });
      await this.insertRecentChange(tx, {
        pageId: page.id,
        revisionId: revision.id,
        actorId: actor.id,
        changeType: 'edit',
        title: page.title,
        namespaceCode: namespace.code,
        summary: revision.editSummary,
        isMinor: revision.isMinor,
        createdAt: now
      });
      return {
        pageId: page.id.toString(),
        revisionId: revision.id.toString(),
        revisionNo: revision.revisionNo,
        namespace: namespace.code,
        title: page.title,
        slug: page.slug
      };
    });
    await this.events?.audit('wiki.edit', {
      category: 'wiki',
      actorAccountId: session.userId,
      actorProfileId: actor.id,
      subjectType: 'wiki_page',
      subjectId: result.pageId,
      metadata: {
        namespace: result.namespace,
        title: result.title,
        revisionId: result.revisionId,
        revisionNo: result.revisionNo
      }
    });
    return result;
  }

  async appendSection(session: SessionPayload, pageId: string, request: WikiSectionMutationRequest): Promise<WikiMutationResponse> {
    const parsedPageId = this.parseBigIntId(pageId, 'pageId');
    const heading = this.requiredString(request.heading, 'heading');
    const sectionContent = this.requiredString(request.contentRaw, 'contentRaw');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: parsedPageId } });
    if (!page) {
      throw new NotFoundException('Wiki page not found.');
    }
    const actor = await this.wikiProfiles.ensureWikiProfile(session.userId);
    await this.wikiPermissions.assertCanEditPage({
      actor: this.wikiPermissions.actorFromSession(session, actor),
      page
    });
    const latest = await this.findLatestRevision(this.prisma, page.id);
    if (!latest) {
      throw new NotFoundException('Public wiki revision not found.');
    }
    const appended = `${latest.contentRaw.trimEnd()}\n\n== ${heading} ==\n${sectionContent.trim()}\n`;
    return this.updatePage(session, pageId, {
      contentRaw: appended,
      editSummary: request.editSummary ?? `섹션 추가: ${heading}`,
      isMinor: request.isMinor,
      baseRevisionId: request.baseRevisionId
    });
  }

  async getRevision(revisionId: string, accountId?: string | null): Promise<WikiRevisionResponse> {
    const id = this.parseBigIntId(revisionId, 'revisionId');
    const revision = await this.prisma.wikiPageRevision.findUnique({ where: { id } });
    if (!revision || revision.visibility !== 'public') {
      throw new NotFoundException('Wiki revision not found.');
    }
    const page = await this.prisma.wikiPage.findUnique({ where: { id: revision.pageId } });
    await this.wikiPermissions.assertCanReadPage({
      accountId: accountId ?? null,
      page,
      revision
    });
    return this.toRevisionResponse(revision);
  }

  async getRevisionDiff(leftId: string, rightId: string, accountId?: string | null): Promise<WikiRevisionDiffResponse> {
    const [left, right] = await Promise.all([
      this.getRevision(leftId, accountId ?? null),
      this.getRevision(rightId, accountId ?? null)
    ]);
    return {
      left,
      right,
      hunks: this.diffLines(left.contentRaw, right.contentRaw)
    };
  }

  preview(contentRaw: string | undefined): WikiPreviewResponse {
    const parsed = parseMarkup(contentRaw ?? '');
    return {
      html: renderDocument(parsed.ast),
      links: parsed.links,
      categories: parsed.categories,
      errors: parsed.errors,
      blockingErrors: parsed.blockingErrors
    };
  }

  private async findDefaultSpaceId(namespaceCode: string): Promise<bigint> {
    const direct = await this.prisma.wikiSpace.findFirst({
      where: {
        rootNamespaceCode: namespaceCode,
        status: 'active'
      },
      orderBy: [{ id: 'asc' }]
    });
    if (direct) {
      return direct.id;
    }
    const fallback = await this.prisma.wikiSpace.findFirst({
      where: { status: 'active' },
      orderBy: [{ id: 'asc' }]
    });
    if (!fallback) {
      throw new NotFoundException('Wiki space not found.');
    }
    return fallback.id;
  }

  private async findLatestRevision(tx: Pick<PrismaService, 'wikiPageRevision'>, pageId: bigint) {
    return tx.wikiPageRevision.findFirst({
      where: {
        pageId,
        visibility: 'public'
      },
      orderBy: [{ revisionNo: 'desc' }]
    });
  }

  private async createRevision(
    tx: Pick<PrismaService, 'wikiPageRenderCache' | 'wikiPageRevision'>,
    input: {
      pageId: bigint;
      revisionNo: number;
      parentRevisionId: bigint | null;
      contentRaw: string;
      editSummary?: string | null;
      isMinor: boolean;
      actorId: bigint;
      createdAt: Date;
    }
  ) {
    const parsed = parseMarkup(input.contentRaw);
    if (parsed.blockingErrors.length > 0) {
      throw new BadRequestException(`Wiki markup contains blocking errors: ${parsed.blockingErrors.join(', ')}`);
    }
    const revision = await tx.wikiPageRevision.create({
      data: {
        pageId: input.pageId,
        revisionNo: input.revisionNo,
        parentRevisionId: input.parentRevisionId,
        contentRaw: input.contentRaw,
        contentAst: JSON.parse(JSON.stringify(parsed.ast)),
        contentHash: hashContent(input.contentRaw),
        contentSize: Buffer.byteLength(input.contentRaw, 'utf8'),
        syntaxVersion: 'bwm-0.3',
        editSummary: input.editSummary ?? null,
        isMinor: input.isMinor,
        editTags: null,
        createdBy: input.actorId,
        actorType: 'user',
        actorUserId: input.actorId,
        actorIp: null,
        actorIpText: null,
        actorIpHash: null,
        createdAt: input.createdAt,
        visibility: 'public'
      }
    });
    await tx.wikiPageRenderCache.create({
      data: {
        pageId: input.pageId,
        revisionId: revision.id,
        rendererVersion: WIKI_RENDERER_VERSION,
        html: renderDocument(parsed.ast),
        createdAt: input.createdAt
      }
    });
    return revision;
  }

  private async insertRecentChange(
    tx: Pick<PrismaService, 'wikiRecentChange'>,
    input: {
      pageId: bigint;
      revisionId: bigint;
      actorId: bigint;
      changeType: ChangeType;
      title: string;
      namespaceCode: string;
      summary?: string | null;
      isMinor: boolean;
      createdAt: Date;
    }
  ): Promise<void> {
    await tx.wikiRecentChange.create({
      data: {
        pageId: input.pageId,
        revisionId: input.revisionId,
        actorId: input.actorId,
        changeType: input.changeType,
        title: input.title,
        namespaceCode: input.namespaceCode,
        summary: input.summary ?? null,
        isMinor: input.isMinor,
        createdAt: input.createdAt
      }
    });
  }

  private toRevisionResponse(revision: {
    id: bigint;
    pageId: bigint;
    revisionNo: number;
    parentRevisionId: bigint | null;
    contentRaw: string;
    contentHash: string;
    contentSize: number;
    syntaxVersion: string;
    editSummary: string | null;
    isMinor: boolean;
    createdBy: bigint | null;
    actorUserId: bigint | null;
    createdAt: Date;
    visibility: string;
  }): WikiRevisionResponse {
    return {
      id: revision.id.toString(),
      pageId: revision.pageId.toString(),
      revisionNo: revision.revisionNo,
      parentRevisionId: revision.parentRevisionId?.toString() ?? null,
      contentRaw: revision.contentRaw,
      contentHash: revision.contentHash,
      contentSize: revision.contentSize,
      syntaxVersion: revision.syntaxVersion,
      editSummary: revision.editSummary,
      isMinor: revision.isMinor,
      createdBy: revision.createdBy?.toString() ?? null,
      actorUserId: revision.actorUserId?.toString() ?? null,
      createdAt: revision.createdAt.toISOString(),
      visibility: revision.visibility
    };
  }

  private diffLines(left: string, right: string): WikiRevisionDiffResponse['hunks'] {
    const leftLines = left.split('\n');
    const rightLines = right.split('\n');
    const max = Math.max(leftLines.length, rightLines.length);
    const hunks: WikiRevisionDiffResponse['hunks'] = [];
    for (let index = 0; index < max; index += 1) {
      const leftLine = leftLines[index];
      const rightLine = rightLines[index];
      if (leftLine === rightLine) {
        if (leftLine !== undefined) {
          hunks.push({ type: 'context', line: leftLine, leftLine: index + 1, rightLine: index + 1 });
        }
        continue;
      }
      if (leftLine !== undefined) {
        hunks.push({ type: 'removed', line: leftLine, leftLine: index + 1, rightLine: null });
      }
      if (rightLine !== undefined) {
        hunks.push({ type: 'added', line: rightLine, leftLine: null, rightLine: index + 1 });
      }
    }
    return hunks;
  }

  private cleanNamespace(value?: string): string {
    return this.cleanOptional(value) ?? 'main';
  }

  private cleanOptional(value?: string | null): string | null {
    const cleaned = value?.trim();
    return cleaned ? cleaned : null;
  }

  private requiredString(value: string | undefined, label: string): string {
    const cleaned = this.cleanOptional(value);
    if (!cleaned) {
      throw new BadRequestException(`${label} is required.`);
    }
    return cleaned;
  }

  private parseBigIntId(value: string, label: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException(`${label} must be an unsigned integer.`);
    }
    return BigInt(value);
  }
}
