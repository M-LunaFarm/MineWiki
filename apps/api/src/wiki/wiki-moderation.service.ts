import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { hashContent, parseMarkup, renderDocument, wikiUrl, WIKI_RENDERER_VERSION } from '@minewiki/wiki-core';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import { astContainsFile } from './wiki-edit.service';
import { WikiLinkIndexService } from './wiki-link-index.service';
import { WikiNotificationService } from './wiki-notification.service';

const MAX_WINDOW_MINUTES = 24 * 60;
const MAX_PAGES = 25;
const MAX_AFFECTED_REVISIONS_PER_PAGE = 100;

type ModerationStore = Prisma.TransactionClient | PrismaService;

export interface WikiBatchRollbackCandidate {
  readonly pageId: string;
  readonly title: string;
  readonly routePath: string | null;
  readonly expectedCurrentRevisionId: string | null;
  readonly rollbackToRevisionId: string | null;
  readonly affectedRevisionIds: string[];
  readonly action: 'rollback' | 'manual';
  readonly skipReason: string | null;
}

export interface WikiBatchRollbackPreview {
  readonly target: { id: string; username: string; displayName: string; status: string };
  readonly sinceMinutes: number;
  readonly candidates: WikiBatchRollbackCandidate[];
}

export interface WikiBatchRollbackResult {
  readonly pageId: string;
  readonly status: 'rolled_back' | 'skipped' | 'failed';
  readonly reason: string | null;
  readonly newRevisionId: string | null;
}

@Injectable()
export class WikiModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiLinks: WikiLinkIndexService,
    private readonly notifications: WikiNotificationService,
    @Optional() private readonly events?: BusinessEventService
  ) {}

  async preview(input: {
    readonly targetProfileId?: string;
    readonly sinceMinutes?: number | string;
    readonly limit?: number | string;
  }): Promise<WikiBatchRollbackPreview> {
    const targetId = this.parseId(input.targetProfileId, 'targetProfileId');
    const sinceMinutes = this.parseBoundedInt(input.sinceMinutes, 'sinceMinutes', MAX_WINDOW_MINUTES, 60);
    const limit = this.parseBoundedInt(input.limit, 'limit', MAX_PAGES, MAX_PAGES);
    const target = await this.prisma.wikiProfile.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundException('Wiki profile not found.');
    const since = new Date(Date.now() - sinceMinutes * 60_000);
    const pages = await this.prisma.wikiPageRevision.groupBy({
      by: ['pageId'],
      where: { createdBy: targetId, visibility: 'public', createdAt: { gte: since } },
      _max: { createdAt: true },
      orderBy: [{ _max: { createdAt: 'desc' } }, { pageId: 'desc' }],
      take: limit
    });
    const candidates = await Promise.all(
      pages.map((entry) => this.planPage(this.prisma, entry.pageId, targetId, since))
    );
    return {
      target: { id: target.id.toString(), username: target.username, displayName: target.displayName, status: target.status },
      sinceMinutes,
      candidates
    };
  }

  async execute(input: {
    readonly targetProfileId?: string;
    readonly sinceMinutes?: number | string;
    readonly reason?: string;
    readonly confirmUsername?: string;
    readonly candidates?: ReadonlyArray<{ readonly pageId?: string; readonly expectedCurrentRevisionId?: string }>;
    readonly actorProfileId: bigint;
  }): Promise<{ targetProfileId: string; results: WikiBatchRollbackResult[] }> {
    const targetId = this.parseId(input.targetProfileId, 'targetProfileId');
    if (targetId === input.actorProfileId) throw new BadRequestException('자기 자신의 기여는 일괄 복구할 수 없습니다.');
    const sinceMinutes = this.parseBoundedInt(input.sinceMinutes, 'sinceMinutes', MAX_WINDOW_MINUTES, 60);
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 5 || reason.length > 1000) throw new BadRequestException('사유는 5자 이상 1000자 이하로 입력하세요.');
    const target = await this.assertTargetEligible(this.prisma, targetId);
    if (input.confirmUsername !== target.username) throw new BadRequestException('대상 사용자 이름 확인이 일치하지 않습니다.');
    const candidates = input.candidates ?? [];
    if (candidates.length < 1 || candidates.length > MAX_PAGES) {
      throw new BadRequestException(`복구 대상 문서는 1개 이상 ${MAX_PAGES}개 이하여야 합니다.`);
    }
    const normalized = candidates.map((candidate) => ({
      pageId: this.parseId(candidate.pageId, 'pageId'),
      expectedCurrentRevisionId: this.parseId(candidate.expectedCurrentRevisionId, 'expectedCurrentRevisionId')
    }));
    if (new Set(normalized.map((candidate) => candidate.pageId.toString())).size !== normalized.length) {
      throw new BadRequestException('중복된 문서가 포함되어 있습니다.');
    }
    const since = new Date(Date.now() - sinceMinutes * 60_000);
    const results: WikiBatchRollbackResult[] = [];
    for (const candidate of normalized) {
      try {
        const result = await this.prisma.$transaction(
          (tx) => this.executePage(tx, {
            ...candidate,
            targetId,
            actorProfileId: input.actorProfileId,
            since,
            reason
          }),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
        results.push(result);
        if (result.status === 'rolled_back') {
          await this.events?.audit('wiki.batch_rollback.page', {
            category: 'wiki', severity: 'warning', actorProfileId: input.actorProfileId,
            subjectType: 'wiki_page', subjectId: candidate.pageId,
            metadata: { targetProfileId: targetId, reason, newRevisionId: result.newRevisionId }
          });
        }
      } catch (error) {
        results.push({
          pageId: candidate.pageId.toString(), status: 'failed',
          reason: this.safeError(error), newRevisionId: null
        });
      }
    }
    await this.events?.audit('wiki.batch_rollback', {
      category: 'wiki', severity: 'warning', actorProfileId: input.actorProfileId,
      subjectType: 'wiki_profile', subjectId: targetId,
      metadata: {
        reason, sinceMinutes,
        rolledBack: results.filter((result) => result.status === 'rolled_back').length,
        skipped: results.filter((result) => result.status === 'skipped').length,
        failed: results.filter((result) => result.status === 'failed').length
      }
    });
    return { targetProfileId: targetId.toString(), results };
  }

  private async executePage(tx: Prisma.TransactionClient, input: {
    readonly pageId: bigint;
    readonly expectedCurrentRevisionId: bigint;
    readonly targetId: bigint;
    readonly actorProfileId: bigint;
    readonly since: Date;
    readonly reason: string;
  }): Promise<WikiBatchRollbackResult> {
    await tx.$queryRaw<Array<{ id: bigint }>>`SELECT id FROM wiki_profiles WHERE id = ${input.targetId} FOR UPDATE`;
    await this.assertTargetEligible(tx, input.targetId);
    await tx.$queryRaw<Array<{ id: bigint }>>`SELECT id FROM pages WHERE id = ${input.pageId} FOR UPDATE`;
    const plan = await this.planPage(tx, input.pageId, input.targetId, input.since);
    if (plan.expectedCurrentRevisionId !== input.expectedCurrentRevisionId.toString()) {
      return { pageId: plan.pageId, status: 'skipped', reason: 'current_changed', newRevisionId: null };
    }
    if (plan.action !== 'rollback' || !plan.rollbackToRevisionId) {
      return { pageId: plan.pageId, status: 'skipped', reason: plan.skipReason ?? 'manual_review', newRevisionId: null };
    }
    const page = await tx.wikiPage.findUnique({ where: { id: input.pageId } });
    const rollbackTo = await tx.wikiPageRevision.findUnique({ where: { id: BigInt(plan.rollbackToRevisionId) } });
    const latestStored = await tx.wikiPageRevision.findFirst({
      where: { pageId: input.pageId }, orderBy: [{ revisionNo: 'desc' }]
    });
    if (!page || !rollbackTo || rollbackTo.pageId !== page.id || rollbackTo.visibility !== 'public') {
      return { pageId: input.pageId.toString(), status: 'skipped', reason: 'safe_base_changed', newRevisionId: null };
    }
    const affectedIds = plan.affectedRevisionIds.map((id) => BigInt(id));
    const hidden = await tx.wikiPageRevision.updateMany({
      where: { id: { in: affectedIds }, pageId: page.id, visibility: 'public', createdBy: input.targetId },
      data: { visibility: 'hidden' }
    });
    if (hidden.count !== affectedIds.length) throw new ConflictException('복구 대상 판이 동시에 변경되었습니다.');
    const parsed = parseMarkup(rollbackTo.contentRaw);
    if (parsed.blockingErrors.length > 0) throw new ConflictException('안전 기준판의 위키 문법을 렌더링할 수 없습니다.');
    const now = new Date();
    const revision = await tx.wikiPageRevision.create({
      data: {
        pageId: page.id,
        revisionNo: (latestStored?.revisionNo ?? 0) + 1,
        parentRevisionId: input.expectedCurrentRevisionId,
        contentRaw: rollbackTo.contentRaw,
        contentAst: JSON.parse(JSON.stringify(parsed.ast)),
        contentHash: hashContent(rollbackTo.contentRaw),
        contentSize: Buffer.byteLength(rollbackTo.contentRaw, 'utf8'),
        syntaxVersion: rollbackTo.syntaxVersion,
        editSummary: `일괄 훼손 복구: ${input.reason}`.slice(0, 255),
        isMinor: false,
        editTags: {
          batchRollback: true,
          targetProfileId: input.targetId.toString(),
          rollbackToRevisionId: rollbackTo.id.toString(),
          affectedRevisionIds: plan.affectedRevisionIds
        },
        createdBy: input.actorProfileId,
        actorType: 'user', actorUserId: input.actorProfileId,
        actorIp: null, actorIpText: null, actorIpHash: null,
        createdAt: now, visibility: 'public'
      }
    });
    if (!astContainsFile(parsed.ast) && parsed.includes.length === 0) {
      await tx.wikiPageRenderCache.create({
        data: {
          pageId: page.id, revisionId: revision.id,
          rendererVersion: WIKI_RENDERER_VERSION,
          html: renderDocument(parsed.ast), createdAt: now
        }
      });
    }
    await this.wikiLinks.replaceForRevision(
      tx,
      page.id,
      revision.id,
      parsed.links,
      parsed.categories,
      parsed.includes,
      { contentSize: revision.contentSize, contentRaw: revision.contentRaw }
    );
    await tx.wikiPage.update({ where: { id: page.id }, data: { currentRevisionId: revision.id, updatedAt: now } });
    const namespace = await tx.wikiNamespace.findUnique({ where: { id: page.namespaceId } });
    await tx.wikiRecentChange.create({
      data: {
        pageId: page.id, revisionId: revision.id, actorId: input.actorProfileId,
        changeType: 'rollback', title: page.title, namespaceCode: namespace?.code ?? 'main',
        summary: revision.editSummary, isMinor: false, createdAt: now
      }
    });
    await this.notifications.notifyWatchedRevision(tx, {
      pageId: page.id, revisionId: revision.id, actorProfileId: input.actorProfileId, title: page.displayTitle
    });
    return { pageId: page.id.toString(), status: 'rolled_back', reason: null, newRevisionId: revision.id.toString() };
  }

  private async planPage(
    store: ModerationStore,
    pageId: bigint,
    targetId: bigint,
    since: Date
  ): Promise<WikiBatchRollbackCandidate> {
    const page = await store.wikiPage.findUnique({ where: { id: pageId } });
    if (!page) return this.manual(pageId, 'missing_page');
    const namespace = await store.wikiNamespace.findUnique({ where: { id: page.namespaceId } });
    const routePath = namespace ? wikiUrl(namespace.code as Parameters<typeof wikiUrl>[0], page.title) : null;
    if (page.status === 'deleted' || !page.currentRevisionId) {
      return this.manual(pageId, page.status === 'deleted' ? 'deleted_page' : 'no_current_revision', page.displayTitle, routePath);
    }
    const current = await store.wikiPageRevision.findUnique({ where: { id: page.currentRevisionId } });
    if (!current || current.pageId !== page.id || current.visibility !== 'public') {
      return this.manual(pageId, 'current_not_public', page.displayTitle, routePath, page.currentRevisionId);
    }
    const revisions = await store.wikiPageRevision.findMany({
      where: { pageId: page.id, visibility: 'public', revisionNo: { lte: current.revisionNo } },
      orderBy: [{ revisionNo: 'desc' }],
      take: MAX_AFFECTED_REVISIONS_PER_PAGE + 1
    });
    const affected = [];
    for (const revision of revisions) {
      if (revision.createdBy !== targetId || revision.createdAt < since) break;
      affected.push(revision);
      if (affected.length === MAX_AFFECTED_REVISIONS_PER_PAGE) break;
    }
    if (affected.length === 0) {
      return this.manual(pageId, 'newer_non_target_revision', page.displayTitle, routePath, current.id);
    }
    const next = revisions[affected.length];
    if (affected.length === MAX_AFFECTED_REVISIONS_PER_PAGE && next?.createdBy === targetId && next.createdAt >= since) {
      return this.manual(pageId, 'too_many_affected_revisions', page.displayTitle, routePath, current.id, affected);
    }
    if (!next) {
      return this.manual(pageId, 'no_safe_base', page.displayTitle, routePath, current.id, affected);
    }
    return {
      pageId: page.id.toString(), title: page.displayTitle, routePath,
      expectedCurrentRevisionId: current.id.toString(),
      rollbackToRevisionId: next.id.toString(),
      affectedRevisionIds: affected.map((revision) => revision.id.toString()),
      action: 'rollback', skipReason: null
    };
  }

  private manual(
    pageId: bigint,
    reason: string,
    title = '알 수 없는 문서',
    routePath: string | null = null,
    currentRevisionId: bigint | null = null,
    affected: ReadonlyArray<{ id: bigint }> = []
  ): WikiBatchRollbackCandidate {
    return {
      pageId: pageId.toString(), title, routePath,
      expectedCurrentRevisionId: currentRevisionId?.toString() ?? null,
      rollbackToRevisionId: null,
      affectedRevisionIds: affected.map((revision) => revision.id.toString()),
      action: 'manual', skipReason: reason
    };
  }

  private async assertTargetEligible(store: ModerationStore, targetId: bigint) {
    const target = await store.wikiProfile.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundException('Wiki profile not found.');
    if (target.status !== 'blocked') throw new ConflictException('일괄 복구 전 대상 사용자를 먼저 차단해야 합니다.');
    if (target.accountId) {
      const roles = await store.accountRole.findMany({ where: { accountId: target.accountId }, include: { role: true } });
      if (roles.some((entry) => entry.role.code === 'owner' || entry.role.code === 'admin')) {
        throw new BadRequestException('보호된 운영자 계정은 일괄 복구 대상으로 선택할 수 없습니다.');
      }
    }
    return target;
  }

  private parseId(value: string | undefined, label: string): bigint {
    if (!value || !/^\d+$/.test(value)) throw new BadRequestException(`${label} must be an unsigned integer.`);
    return BigInt(value);
  }

  private parseBoundedInt(value: number | string | undefined, label: string, max: number, fallback: number): number {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
      throw new BadRequestException(`${label} must be between 1 and ${max}.`);
    }
    return parsed;
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : '일괄 복구에 실패했습니다.';
    return message.slice(0, 255);
  }
}
