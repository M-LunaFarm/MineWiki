import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  collectWikiFileNames,
  parseMarkup,
} from '@minewiki/wiki-core';
import { Prisma, type WikiPage, type WikiPageRevision } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { writeAuditRecord } from '../events/audit-event-writer';
import type { SessionPayload } from '../session/session.service';
import { WikiLinkIndexService } from './wiki-link-index.service';
import { wikiLinkResolutionContext } from './wiki-link-context';
import { WikiPermissionService, type WikiPermissionActor } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';

const EXCLUDED_SWAP_NAMESPACES = new Set(['user', 'file', 'server']);
const MIN_CANDIDATE_QUERY_LENGTH = 2;
const MAX_CANDIDATE_QUERY_LENGTH = 100;
const CANDIDATE_QUERY_LIMIT = 50;
const CANDIDATE_RESPONSE_LIMIT = 20;

export interface WikiPageSwapRequest {
  readonly targetPageId?: string;
  readonly expectedSourceRevisionId?: string;
  readonly expectedTargetRevisionId?: string;
  readonly reason?: string;
  readonly sourceTitleConfirmation?: string;
  readonly targetTitleConfirmation?: string;
}

export interface WikiPageSwapCandidateResponse {
  readonly items: ReadonlyArray<{
    readonly pageId: string;
    readonly title: string;
    readonly displayTitle: string;
    readonly currentRevisionId: string;
  }>;
}

export interface WikiPageSwapResponse {
  readonly source: WikiPageSwapResultPage;
  readonly target: WikiPageSwapResultPage;
}

export interface WikiPageSwapResultPage {
  readonly pageId: string;
  readonly namespace: string;
  readonly spaceId: string;
  readonly title: string;
  readonly slug: string;
  readonly revisionId: string;
  readonly revisionNo: number;
}

@Injectable()
export class WikiPageSwapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiProfiles: WikiProfileService,
    private readonly wikiPermissions: WikiPermissionService,
    private readonly wikiLinks: WikiLinkIndexService,
  ) {}

  async listCandidates(
    session: SessionPayload,
    sourcePageId: string,
    query?: string,
  ): Promise<WikiPageSwapCandidateResponse> {
    const parsedSourcePageId = this.parseId(sourcePageId, 'pageId');
    const normalizedQuery = query?.normalize('NFKC').trim() ?? '';
    if (normalizedQuery.length < MIN_CANDIDATE_QUERY_LENGTH) {
      throw new BadRequestException(`q must be at least ${MIN_CANDIDATE_QUERY_LENGTH} characters.`);
    }
    if (normalizedQuery.length > MAX_CANDIDATE_QUERY_LENGTH) {
      throw new BadRequestException(`q must be at most ${MAX_CANDIDATE_QUERY_LENGTH} characters.`);
    }

    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    const source = await this.prisma.wikiPage.findUnique({ where: { id: parsedSourcePageId } });
    if (!source) throw new NotFoundException('Wiki page not found.');
    const [namespace, space, sourceRevision] = await Promise.all([
      this.prisma.wikiNamespace.findUnique({ where: { id: source.namespaceId } }),
      this.prisma.wikiSpace.findUnique({ where: { id: source.spaceId } }),
      source.currentRevisionId
        ? this.prisma.wikiPageRevision.findUnique({ where: { id: source.currentRevisionId } })
        : null,
    ]);
    if (!namespace || !space || !sourceRevision || sourceRevision.pageId !== source.id) {
      throw new NotFoundException('Wiki page not found.');
    }
    await this.assertReadableAndMovable(actor, source, sourceRevision, this.prisma);
    await this.assertEligiblePage(this.prisma, source, namespace.code, space, 'source');

    const candidates = await this.prisma.wikiPage.findMany({
      where: {
        id: { not: source.id },
        namespaceId: source.namespaceId,
        spaceId: source.spaceId,
        status: 'normal',
        pageType: 'article',
        currentRevisionId: { not: null },
        OR: [
          { title: { contains: normalizedQuery } },
          { displayTitle: { contains: normalizedQuery } },
        ],
      },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      take: CANDIDATE_QUERY_LIMIT,
    });
    const revisionIds = candidates.flatMap((candidate) => candidate.currentRevisionId ? [candidate.currentRevisionId] : []);
    const revisions = revisionIds.length > 0
      ? await this.prisma.wikiPageRevision.findMany({ where: { id: { in: revisionIds } } })
      : [];
    const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
    const items: WikiPageSwapCandidateResponse['items'][number][] = [];

    for (const candidate of candidates) {
      if (!candidate.currentRevisionId) continue;
      const revision = revisionById.get(candidate.currentRevisionId);
      if (!revision || revision.pageId !== candidate.id || revision.visibility !== 'public') continue;
      try {
        await this.assertEligiblePage(this.prisma, candidate, namespace.code, space, 'target');
        await this.assertReadableAndMovable(actor, candidate, revision, this.prisma);
        await this.assertCreateAtBothTitles(this.prisma, actor, namespace.code, source, candidate);
      } catch (error) {
        if (error instanceof HttpException) continue;
        throw error;
      }
      items.push({
        pageId: candidate.id.toString(),
        title: candidate.title,
        displayTitle: candidate.displayTitle,
        currentRevisionId: revision.id.toString(),
      });
      if (items.length >= CANDIDATE_RESPONSE_LIMIT) break;
    }
    return { items };
  }

  async swap(
    session: SessionPayload,
    sourcePageId: string,
    request: WikiPageSwapRequest,
  ): Promise<WikiPageSwapResponse> {
    const parsedSourcePageId = this.parseId(sourcePageId, 'pageId');
    const targetPageId = this.parseId(this.required(request.targetPageId, 'targetPageId'), 'targetPageId');
    if (parsedSourcePageId === targetPageId) throw new BadRequestException('A page cannot be swapped with itself.');
    const expectedSourceRevisionId = this.parseId(
      this.required(request.expectedSourceRevisionId, 'expectedSourceRevisionId'),
      'expectedSourceRevisionId',
    );
    const expectedTargetRevisionId = this.parseId(
      this.required(request.expectedTargetRevisionId, 'expectedTargetRevisionId'),
      'expectedTargetRevisionId',
    );
    const reason = this.required(request.reason, 'reason');
    if (reason.length < 5 || reason.length > 255) {
      throw new BadRequestException('reason must be between 5 and 255 characters.');
    }
    const sourceTitleConfirmation = this.normalizedConfirmation(
      this.required(request.sourceTitleConfirmation, 'sourceTitleConfirmation'),
    );
    const targetTitleConfirmation = this.normalizedConfirmation(
      this.required(request.targetTitleConfirmation, 'targetTitleConfirmation'),
    );
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    const now = new Date();
    const sentinel = `__swap__${randomUUID()}`;

    return this.prisma.$transaction(async (tx) => {
      await this.lockPages(tx, [parsedSourcePageId, targetPageId]);
      const [source, target] = await Promise.all([
        tx.wikiPage.findUnique({ where: { id: parsedSourcePageId } }),
        tx.wikiPage.findUnique({ where: { id: targetPageId } }),
      ]);
      if (!source) throw new NotFoundException('Wiki page not found.');
      if (!target) throw new NotFoundException('Wiki page not found.');

      const [namespace, space, sourceRevision, targetRevision] = await Promise.all([
        tx.wikiNamespace.findUnique({ where: { id: source.namespaceId } }),
        tx.wikiSpace.findUnique({ where: { id: source.spaceId } }),
        source.currentRevisionId
          ? tx.wikiPageRevision.findUnique({ where: { id: source.currentRevisionId } })
          : null,
        target.currentRevisionId
          ? tx.wikiPageRevision.findUnique({ where: { id: target.currentRevisionId } })
          : null,
      ]);
      if (!namespace || !space || !sourceRevision || sourceRevision.pageId !== source.id) {
        throw new NotFoundException('Wiki page not found.');
      }
      if (!targetRevision || targetRevision.pageId !== target.id) {
        throw new NotFoundException('Wiki page not found.');
      }

      await this.assertReadableAndMovable(actor, source, sourceRevision, tx);
      await this.assertHiddenTargetAccess(actor, target, targetRevision, tx);
      await this.assertEligiblePair(tx, source, target, namespace.code, space);
      await this.assertCreateAtBothTitles(tx, actor, namespace.code, source, target);
      this.assertTitleConfirmation(source.title, sourceTitleConfirmation, 'sourceTitleConfirmation');
      this.assertTitleConfirmation(target.title, targetTitleConfirmation, 'targetTitleConfirmation');
      if (source.currentRevisionId !== expectedSourceRevisionId || target.currentRevisionId !== expectedTargetRevisionId) {
        throw new ConflictException({
          code: 'wiki_swap_revision_stale',
          message: 'One of the pages changed after the swap was prepared.',
        });
      }

      await this.lockNamespace(tx, source.namespaceId);
      await tx.wikiPage.update({
        where: { id: source.id },
        data: {
          localPath: sentinel,
          slug: sentinel,
          title: sentinel,
          displayTitle: sentinel,
          updatedAt: now,
        },
      });
      const updatedTarget = await tx.wikiPage.update({
        where: { id: target.id },
        data: {
          localPath: source.localPath,
          slug: source.slug,
          title: source.title,
          displayTitle: source.displayTitle,
          updatedAt: now,
        },
      });
      const updatedSource = await tx.wikiPage.update({
        where: { id: source.id },
        data: {
          localPath: target.localPath,
          slug: target.slug,
          title: target.title,
          displayTitle: target.displayTitle,
          updatedAt: now,
        },
      });

      await tx.wikiPageRenderCache.deleteMany({
        where: { pageId: { in: [source.id, target.id] } },
      });
      await this.rebuildCurrentArtifacts(tx, updatedSource, sourceRevision, namespace.code);
      await this.rebuildCurrentArtifacts(tx, updatedTarget, targetRevision, namespace.code);

      await tx.wikiRecentChange.createMany({
        data: [
          {
            pageId: source.id,
            revisionId: sourceRevision.id,
            actorId: profile.id,
            changeType: 'move',
            title: updatedSource.title,
            namespaceCode: namespace.code,
            summary: this.swapSummary(source, updatedSource, reason),
            isMinor: false,
            createdAt: now,
          },
          {
            pageId: target.id,
            revisionId: targetRevision.id,
            actorId: profile.id,
            changeType: 'move',
            title: updatedTarget.title,
            namespaceCode: namespace.code,
            summary: this.swapSummary(target, updatedTarget, reason),
            isMinor: false,
            createdAt: now,
          },
        ],
      });
      await writeAuditRecord(tx, {
        data: {
          category: 'wiki',
          action: 'wiki.swap',
          severity: 'info',
          actorAccountId: session.userId,
          actorProfileId: profile.id,
          subjectType: 'wiki_page',
          subjectId: source.id.toString(),
          metadata: {
            sourcePageId: source.id.toString(),
            targetPageId: target.id.toString(),
            sourceBefore: this.auditPath(namespace.code, source),
            sourceAfter: this.auditPath(namespace.code, updatedSource),
            targetBefore: this.auditPath(namespace.code, target),
            targetAfter: this.auditPath(namespace.code, updatedTarget),
            reason,
          },
          createdAt: now,
        },
      });

      return {
        source: this.resultPage(updatedSource, sourceRevision, namespace.code),
        target: this.resultPage(updatedTarget, targetRevision, namespace.code),
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        throw new ConflictException({
          code: 'wiki_swap_path_conflict',
          message: 'A page path changed while the swap was being completed.',
        });
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') {
        throw new ConflictException({
          code: 'wiki_swap_concurrency_conflict',
          message: 'The pages changed concurrently. Refresh and try the swap again.',
        });
      }
      throw error;
    });
  }

  private async assertEligiblePair(
    store: Prisma.TransactionClient,
    source: WikiPage,
    target: WikiPage,
    namespaceCode: string,
    space: { readonly id: bigint; readonly status: string; readonly spaceType: string; readonly rootPageId: bigint | null },
  ): Promise<void> {
    if (source.namespaceId !== target.namespaceId || source.spaceId !== target.spaceId) {
      throw new BadRequestException('Pages can only be swapped inside the same namespace and wiki space.');
    }
    await this.assertEligiblePage(store, source, namespaceCode, space, 'source');
    await this.assertEligiblePage(store, target, namespaceCode, space, 'target');
  }

  private async assertEligiblePage(
    store: Pick<PrismaService, 'wikiPage'>,
    page: WikiPage,
    namespaceCode: string,
    space: { readonly id: bigint; readonly status: string; readonly spaceType: string; readonly rootPageId: bigint | null },
    label: 'source' | 'target',
  ): Promise<void> {
    if (space.id !== page.spaceId || space.status !== 'active') {
      throw new NotFoundException('Wiki space not found.');
    }
    if (EXCLUDED_SWAP_NAMESPACES.has(namespaceCode) || space.spaceType === 'server_wiki') {
      throw new BadRequestException('User, file, and server wiki pages cannot be swapped.');
    }
    if (page.status !== 'normal' || page.pageType !== 'article') {
      throw new BadRequestException(`The ${label} page must be a normal article.`);
    }
    if (space.rootPageId === page.id) {
      throw new BadRequestException(`The ${label} page cannot be a wiki space root.`);
    }
    const child = await store.wikiPage.findFirst({
      where: {
        id: { not: page.id },
        namespaceId: page.namespaceId,
        spaceId: page.spaceId,
        localPath: { startsWith: `${page.localPath}/` },
        status: { not: 'deleted' },
      },
      select: { id: true },
    });
    if (child) throw new BadRequestException(`The ${label} page must not have descendants.`);
  }

  private async assertReadableAndMovable(
    actor: WikiPermissionActor,
    page: WikiPage,
    revision: WikiPageRevision,
    store: Prisma.TransactionClient | PrismaService,
  ): Promise<void> {
    await this.wikiPermissions.assertCanReadPage({ actor, page, revision, store });
    await this.wikiPermissions.assertCanMutatePageAction({ actor, action: 'move', page, store });
  }

  private async assertHiddenTargetAccess(
    actor: WikiPermissionActor,
    page: WikiPage,
    revision: WikiPageRevision,
    store: Prisma.TransactionClient | PrismaService,
  ): Promise<void> {
    try {
      await this.assertReadableAndMovable(actor, page, revision, store);
    } catch (error) {
      if (error instanceof HttpException) throw new NotFoundException('Wiki page not found.');
      throw error;
    }
  }

  private async assertCreateAtBothTitles(
    store: Prisma.TransactionClient | PrismaService,
    actor: WikiPermissionActor,
    namespaceCode: string,
    source: WikiPage,
    target: WikiPage,
  ): Promise<void> {
    await this.wikiPermissions.assertCanCreatePage({
      actor,
      namespaceCode,
      spaceId: source.spaceId,
      title: target.title,
      pageType: 'article',
      store,
    });
    await this.wikiPermissions.assertCanCreatePage({
      actor,
      namespaceCode,
      spaceId: source.spaceId,
      title: source.title,
      pageType: 'article',
      store,
    });
  }

  private async rebuildCurrentArtifacts(
    tx: Prisma.TransactionClient,
    page: WikiPage,
    revision: WikiPageRevision,
    namespaceCode: string,
  ): Promise<void> {
    const linkResolution = wikiLinkResolutionContext(namespaceCode, page.localPath);
    const parsed = parseMarkup(revision.contentRaw, { linkResolution });
    const fileNames = [...collectWikiFileNames(parsed.ast)];
    await this.wikiLinks.replaceForRevision(
      tx,
      page.id,
      revision.id,
      parsed.links,
      parsed.categories,
      parsed.includes,
      {
        contentSize: revision.contentSize,
        contentRaw: revision.contentRaw,
        fileNames,
        redirectTarget: parsed.redirectTarget,
      },
    );
  }

  private async lockPages(tx: Prisma.TransactionClient, pageIds: readonly bigint[]): Promise<void> {
    for (const pageId of [...new Set(pageIds)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
      await tx.$queryRaw<Array<{ id: bigint }>>`
        SELECT id
        FROM pages
        WHERE id = ${pageId}
        FOR UPDATE
      `;
    }
  }

  private async lockNamespace(tx: Prisma.TransactionClient, namespaceId: number): Promise<void> {
    await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id
      FROM namespaces
      WHERE id = ${namespaceId}
      FOR UPDATE
    `;
  }

  private resultPage(page: WikiPage, revision: WikiPageRevision, namespace: string): WikiPageSwapResultPage {
    return {
      pageId: page.id.toString(),
      namespace,
      spaceId: page.spaceId.toString(),
      title: page.title,
      slug: page.slug,
      revisionId: revision.id.toString(),
      revisionNo: revision.revisionNo,
    };
  }

  private swapSummary(before: WikiPage, after: WikiPage, reason: string): string {
    return `${before.title} -> ${after.title} | ${reason}`.slice(0, 255);
  }

  private auditPath(namespace: string, page: Pick<WikiPage, 'spaceId' | 'localPath' | 'title'>) {
    return {
      namespace,
      spaceId: page.spaceId.toString(),
      localPath: page.localPath,
      title: page.title,
    };
  }

  private assertTitleConfirmation(actual: string, confirmation: string, label: string): void {
    if (actual.normalize('NFKC').trim() !== confirmation) {
      throw new BadRequestException(`${label} does not match the current page title.`);
    }
  }

  private normalizedConfirmation(value: string): string {
    return value.normalize('NFKC').trim();
  }

  private required(value: string | undefined, label: string): string {
    const normalized = value?.trim();
    if (!normalized) throw new BadRequestException(`${label} is required.`);
    return normalized;
  }

  private parseId(value: string, label: string): bigint {
    if (!/^\d+$/.test(value)) throw new BadRequestException(`${label} must be an unsigned integer.`);
    return BigInt(value);
  }
}
