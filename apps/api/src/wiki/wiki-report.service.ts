import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService, type WikiPermissionActor, type WikiPermissionPage } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';

export const WIKI_REPORT_TARGET_TYPES = ['page', 'revision', 'discussion', 'comment'] as const;
export type WikiReportTargetType = (typeof WIKI_REPORT_TARGET_TYPES)[number];

export interface WikiReportInput {
  readonly targetType?: string;
  readonly targetId?: string;
  readonly reason?: string;
}

export interface WikiReportResponse {
  readonly caseId: string;
  readonly targetType: WikiReportTargetType;
  readonly targetId: string;
  readonly status: 'open' | 'in_review';
  readonly reportCount: number;
  readonly version: number;
  readonly deduplicated: boolean;
  readonly createdAt: string;
}

interface TargetEvidence {
  readonly pageId: bigint;
  readonly snapshot: Prisma.InputJsonObject;
}

const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const MAX_EVIDENCE_EXCERPT_LENGTH = 8_000;
const PUBLIC_THREAD_STATUSES = new Set(['open', 'paused', 'closed']);
const TARGET_NOT_FOUND_MESSAGE = 'Wiki report target not found.';
const MAX_AGGREGATION_ATTEMPTS = 3;

@Injectable()
export class WikiReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: WikiProfileService,
    private readonly permissions: WikiPermissionService,
  ) {}

  async report(session: SessionPayload, input: WikiReportInput): Promise<WikiReportResponse> {
    const targetType = parseTargetType(input.targetType);
    const targetId = parseTargetId(input.targetId);
    const reason = parseReason(input.reason);
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    if (profile.status !== 'active') {
      throw new ForbiddenException('An active wiki profile is required to report abuse.');
    }
    const actor = this.permissions.actorFromSession(session, profile);
    const evidence = await this.loadEvidence(targetType, targetId, actor);
    const activeKey = `${targetType}:${targetId.toString()}`;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_AGGREGATION_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          const existing = await tx.wikiReportCase.findUnique({ where: { activeKey } });
          if (existing) {
            const duplicate = await tx.wikiReportSubmission.findUnique({
              where: {
                caseId_reporterProfileId: {
                  caseId: existing.id,
                  reporterProfileId: profile.id,
                },
              },
              select: { id: true },
            });
            if (duplicate) return { reportCase: existing, deduplicated: true };

            await tx.wikiReportSubmission.create({
              data: {
                caseId: existing.id,
                reporterProfileId: profile.id,
                reason,
                evidenceSnapshot: evidence.snapshot,
              },
            });
            const updated = await tx.wikiReportCase.update({
              where: { id: existing.id },
              data: {
                reportCount: { increment: 1 },
                version: { increment: 1 },
              },
            });
            return { reportCase: updated, deduplicated: false };
          }

          const now = new Date();
          const created = await tx.wikiReportCase.create({
            data: {
              targetType,
              targetId,
              pageId: evidence.pageId,
              activeKey,
              reportCount: 1,
              evidenceSnapshot: evidence.snapshot,
              status: 'open',
              version: 1,
              statusUpdatedAt: now,
              createdAt: now,
              updatedAt: now,
            },
          });
          await tx.wikiReportSubmission.create({
            data: {
              caseId: created.id,
              reporterProfileId: profile.id,
              reason,
              evidenceSnapshot: evidence.snapshot,
              createdAt: now,
            },
          });
          return { reportCase: created, deduplicated: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        return {
          caseId: result.reportCase.id,
          targetType: result.reportCase.targetType,
          targetId: result.reportCase.targetId.toString(),
          status: result.reportCase.status as 'open' | 'in_review',
          reportCount: result.reportCase.reportCount,
          version: result.reportCase.version,
          deduplicated: result.deduplicated,
          createdAt: result.reportCase.createdAt.toISOString(),
        };
      } catch (error) {
        if (!isRetryableAggregationError(error)) throw error;
        lastError = error;
      }
    }

    throw new ConflictException('The report changed concurrently. Please retry.', { cause: lastError });
  }

  private async loadEvidence(
    targetType: WikiReportTargetType,
    targetId: bigint,
    actor: WikiPermissionActor,
  ): Promise<TargetEvidence> {
    try {
      if (targetType === 'page') return await this.loadPageEvidence(targetId, actor);
      if (targetType === 'revision') return await this.loadRevisionEvidence(targetId, actor);
      if (targetType === 'discussion') return await this.loadDiscussionEvidence(targetId, actor);
      return await this.loadCommentEvidence(targetId, actor);
    } catch (error) {
      if (error instanceof NotFoundException) throw targetNotFound();
      throw error;
    }
  }

  private async loadPageEvidence(pageId: bigint, actor: WikiPermissionActor): Promise<TargetEvidence> {
    const page = await this.prisma.wikiPage.findUnique({ where: { id: pageId } });
    if (!page) throw targetNotFound();
    const revision = page.currentRevisionId
      ? await this.prisma.wikiPageRevision.findUnique({ where: { id: page.currentRevisionId } })
      : null;
    if (page.currentRevisionId && (!revision || revision.pageId !== page.id)) throw targetNotFound();
    await this.permissions.assertCanReadPage({ actor, page, revision });
    return {
      pageId: page.id,
      snapshot: {
        capturedAt: new Date().toISOString(),
        targetType: 'page',
        targetId: page.id.toString(),
        page: pageSnapshot(page),
        revision: revision ? revisionSnapshot(revision) : null,
      },
    };
  }

  private async loadRevisionEvidence(revisionId: bigint, actor: WikiPermissionActor): Promise<TargetEvidence> {
    const revision = await this.prisma.wikiPageRevision.findUnique({ where: { id: revisionId } });
    const page = revision
      ? await this.prisma.wikiPage.findUnique({ where: { id: revision.pageId } })
      : null;
    if (!revision || !page) throw targetNotFound();
    await this.permissions.assertCanReadPage({ actor, page, revision });
    return {
      pageId: page.id,
      snapshot: {
        capturedAt: new Date().toISOString(),
        targetType: 'revision',
        targetId: revision.id.toString(),
        page: pageSnapshot(page),
        revision: revisionSnapshot(revision),
      },
    };
  }

  private async loadDiscussionEvidence(threadId: bigint, actor: WikiPermissionActor): Promise<TargetEvidence> {
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id: threadId } });
    const page = thread
      ? await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } })
      : null;
    if (!thread || !page || !PUBLIC_THREAD_STATUSES.has(thread.status)) throw targetNotFound();
    await this.permissions.assertCanReadThread({ actor, thread, page });
    const firstComment = await this.prisma.wikiDiscussionComment.findFirst({
      where: { threadId: thread.id, status: 'normal', entryType: 'comment' },
      orderBy: [{ id: 'asc' }],
      select: { id: true, content: true, createdBy: true, createdAt: true },
    });
    return {
      pageId: page.id,
      snapshot: {
        capturedAt: new Date().toISOString(),
        targetType: 'discussion',
        targetId: thread.id.toString(),
        page: pageSnapshot(page),
        discussion: {
          id: thread.id.toString(),
          title: thread.title,
          status: thread.status,
          createdBy: thread.createdBy.toString(),
          createdAt: thread.createdAt.toISOString(),
          updatedAt: thread.updatedAt.toISOString(),
          firstComment: firstComment
            ? {
                id: firstComment.id.toString(),
                contentExcerpt: boundedExcerpt(firstComment.content),
                createdBy: firstComment.createdBy.toString(),
                createdAt: firstComment.createdAt.toISOString(),
              }
            : null,
        },
      },
    };
  }

  private async loadCommentEvidence(commentId: bigint, actor: WikiPermissionActor): Promise<TargetEvidence> {
    const comment = await this.prisma.wikiDiscussionComment.findUnique({ where: { id: commentId } });
    const thread = comment
      ? await this.prisma.wikiDiscussionThread.findUnique({ where: { id: comment.threadId } })
      : null;
    const page = thread
      ? await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } })
      : null;
    if (
      !comment ||
      !thread ||
      !page ||
      comment.status !== 'normal' ||
      comment.entryType !== 'comment' ||
      !PUBLIC_THREAD_STATUSES.has(thread.status)
    ) {
      throw targetNotFound();
    }
    await this.permissions.assertCanReadThread({ actor, thread, page });
    return {
      pageId: page.id,
      snapshot: {
        capturedAt: new Date().toISOString(),
        targetType: 'comment',
        targetId: comment.id.toString(),
        page: pageSnapshot(page),
        discussion: {
          id: thread.id.toString(),
          title: thread.title,
          status: thread.status,
        },
        comment: {
          id: comment.id.toString(),
          contentExcerpt: boundedExcerpt(comment.content),
          createdBy: comment.createdBy.toString(),
          createdAt: comment.createdAt.toISOString(),
          updatedAt: comment.updatedAt?.toISOString() ?? null,
        },
      },
    };
  }
}

function parseTargetType(value?: string): WikiReportTargetType {
  const targetType = value?.trim();
  if (!WIKI_REPORT_TARGET_TYPES.includes(targetType as WikiReportTargetType)) {
    throw new BadRequestException('targetType must be page, revision, discussion, or comment.');
  }
  return targetType as WikiReportTargetType;
}

function parseTargetId(value?: string): bigint {
  const targetId = value?.trim() ?? '';
  if (!/^[1-9]\d*$/.test(targetId)) throw new BadRequestException('targetId must be an unsigned integer.');
  const parsed = BigInt(targetId);
  if (parsed > MAX_UNSIGNED_BIGINT) throw new BadRequestException('targetId is outside the supported range.');
  return parsed;
}

function parseReason(value?: string): string {
  const reason = value?.trim() ?? '';
  if (reason.length < 3 || reason.length > 1_000) {
    throw new BadRequestException('reason must contain between 3 and 1000 characters.');
  }
  return reason;
}

function pageSnapshot(page: WikiPermissionPage & { displayTitle?: string; currentRevisionId?: bigint | null; updatedAt?: Date }) {
  return {
    id: page.id.toString(),
    spaceId: page.spaceId.toString(),
    namespaceId: page.namespaceId ?? null,
    title: page.title,
    displayTitle: page.displayTitle ?? page.title,
    status: page.status,
    protectionLevel: page.protectionLevel,
    currentRevisionId: page.currentRevisionId?.toString() ?? null,
    updatedAt: page.updatedAt?.toISOString() ?? null,
  };
}

function revisionSnapshot(revision: {
  id: bigint;
  pageId: bigint;
  revisionNo: number;
  contentRaw: string;
  contentHash: string;
  contentSize: number;
  editSummary: string | null;
  createdBy: bigint | null;
  createdAt: Date;
  visibility: string;
}) {
  return {
    id: revision.id.toString(),
    pageId: revision.pageId.toString(),
    revisionNo: revision.revisionNo,
    contentExcerpt: boundedExcerpt(revision.contentRaw),
    contentHash: revision.contentHash,
    contentSize: revision.contentSize,
    editSummary: revision.editSummary,
    createdBy: revision.createdBy?.toString() ?? null,
    createdAt: revision.createdAt.toISOString(),
    visibility: revision.visibility,
  };
}

function boundedExcerpt(value: string): string {
  return value.length <= MAX_EVIDENCE_EXCERPT_LENGTH
    ? value
    : `${value.slice(0, MAX_EVIDENCE_EXCERPT_LENGTH)}\n[truncated]`;
}

function targetNotFound(): NotFoundException {
  return new NotFoundException(TARGET_NOT_FOUND_MESSAGE);
}

function isRetryableAggregationError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2034');
}
