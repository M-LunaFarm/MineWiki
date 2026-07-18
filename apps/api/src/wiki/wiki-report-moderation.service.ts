import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { toAuditJson } from '../events/business-event.service';
import { writeAuditRecord } from '../events/audit-event-writer';
import { RoleService } from '../roles/role.service';
import type { SessionPayload } from '../session/session.service';
import { WIKI_REPORT_TARGET_TYPES, type WikiReportTargetType } from './wiki-report.service';
import { WikiProfileService } from './wiki-profile.service';

export const WIKI_REPORT_STATUSES = ['open', 'in_review', 'resolved', 'dismissed'] as const;
export type WikiReportStatus = (typeof WIKI_REPORT_STATUSES)[number];

export interface WikiReportQueueQuery {
  readonly status?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly assignee?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface WikiReportTransitionInput {
  readonly expectedVersion?: number;
  readonly status?: string;
  readonly resolution?: string;
}

const REPORT_INCLUDE = {
  submissions: {
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 10,
    select: {
      id: true,
      reporterProfileId: true,
      reason: true,
      createdAt: true,
    },
  },
} satisfies Prisma.WikiReportCaseInclude;

const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const CASE_NOT_FOUND_MESSAGE = 'Wiki report case not found.';

@Injectable()
export class WikiReportModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: WikiProfileService,
    private readonly roles: RoleService,
  ) {}

  async listQueue(session: SessionPayload, input: WikiReportQueueQuery) {
    const actor = await this.activeProfile(session.userId);
    const status = parseOptionalStatus(input.status);
    const targetType = parseOptionalTargetType(input.targetType);
    const targetId = input.targetId ? parseProfileOrTargetId(input.targetId, 'targetId') : undefined;
    const assigneeProfileId = input.assignee === 'me'
      ? actor.id
      : input.assignee === 'unassigned'
        ? null
        : input.assignee
          ? parseProfileOrTargetId(input.assignee, 'assignee')
          : undefined;
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const snapshotAt = cursor?.snapshotAt ?? new Date();
    const position = cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null;
    const where: Prisma.WikiReportCaseWhereInput = {
      status,
      targetType,
      targetId,
      assigneeProfileId,
      createdAt: { lte: snapshotAt },
      ...(position ? {
        AND: [{
          OR: [
            { createdAt: { lt: position.createdAt } },
            { createdAt: position.createdAt, id: { lt: position.id } },
          ],
        }],
      } : {}),
    };
    const rows = await this.prisma.wikiReportCase.findMany({
      where,
      include: REPORT_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(toCaseResponse),
      nextCursor: rows.length > limit && last
        ? encodeCursor(snapshotAt, last.createdAt, last.id)
        : null,
      limit,
      snapshotAt: snapshotAt.toISOString(),
    };
  }

  async assign(
    caseId: string,
    session: SessionPayload,
    expectedVersionInput: number | undefined,
    assigneeProfileIdInput?: string | null,
  ) {
    const actor = await this.activeProfile(session.userId);
    const expectedVersion = parseExpectedVersion(expectedVersionInput);
    const assigneeProfileId = assigneeProfileIdInput === undefined
      ? actor.id
      : assigneeProfileIdInput === null
        ? null
        : parseProfileOrTargetId(assigneeProfileIdInput, 'assigneeProfileId');
    if (assigneeProfileId !== null) await this.assertAssignableModerator(assigneeProfileId);
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.wikiReportCase.findUnique({ where: { id: caseId } });
      assertActiveCase(existing);
      const now = new Date();
      const nextStatus: Extract<WikiReportStatus, 'open' | 'in_review'> = assigneeProfileId === null ? 'open' : 'in_review';
      const updated = await tx.wikiReportCase.updateMany({
        where: { id: caseId, version: expectedVersion, status: existing.status },
        data: {
          assigneeProfileId,
          assignedAt: assigneeProfileId === null ? null : now,
          status: nextStatus,
          statusUpdatedAt: now,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw versionConflict();
      const reportCase = await this.findCase(caseId, tx);
      await this.audit(tx, 'wiki.report.assigned', session, actor.id, reportCase, {
        previousStatus: existing.status,
        assigneeProfileId: assigneeProfileId?.toString() ?? null,
      }, now);
      return reportCase;
    });
    return toCaseResponse(result);
  }

  async transition(caseId: string, session: SessionPayload, input: WikiReportTransitionInput) {
    const actor = await this.activeProfile(session.userId);
    const expectedVersion = parseExpectedVersion(input.expectedVersion);
    const status = parseStatus(input.status);
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.wikiReportCase.findUnique({ where: { id: caseId } });
      assertActiveCase(existing);
      if (existing.status === status) throw new ConflictException('The report case is already in that status.');
      const resolution = isFinal(status) ? parseResolution(input.resolution) : null;
      const now = new Date();
      const assigneeProfileId = status === 'open'
        ? null
        : existing.assigneeProfileId ?? actor.id;
      const updated = await tx.wikiReportCase.updateMany({
        where: { id: caseId, version: expectedVersion, status: existing.status },
        data: {
          status,
          assigneeProfileId,
          assignedAt: status === 'open' ? null : existing.assignedAt ?? now,
          resolution,
          activeKey: isFinal(status) ? null : existing.activeKey,
          resolvedAt: status === 'resolved' ? now : null,
          dismissedAt: status === 'dismissed' ? now : null,
          statusUpdatedAt: now,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw versionConflict();
      const reportCase = await this.findCase(caseId, tx);
      await this.audit(tx, `wiki.report.${status}`, session, actor.id, reportCase, {
        previousStatus: existing.status,
        resolution,
      }, now);
      return reportCase;
    });
    return toCaseResponse(result);
  }

  private async activeProfile(accountId: string) {
    const profile = await this.profiles.ensureWikiProfile(accountId);
    if (profile.status !== 'active') {
      throw new ForbiddenException('An active wiki profile is required for report moderation.');
    }
    return profile;
  }

  private async assertAssignableModerator(profileId: bigint): Promise<void> {
    const profile = await this.prisma.wikiProfile.findUnique({
      where: { id: profileId },
      select: { accountId: true, status: true },
    });
    if (!profile || profile.status !== 'active' || !profile.accountId) {
      throw new NotFoundException('Assignable wiki moderator not found.');
    }
    const access = await this.roles.getAccountAccess(profile.accountId);
    if (
      !access.permissions.includes('wiki.report.moderate') &&
      !access.roles.some((role) => role === 'owner' || role === 'admin')
    ) {
      throw new ForbiddenException('The assignee cannot moderate wiki reports.');
    }
  }

  private async findCase(
    caseId: string,
    store: Pick<Prisma.TransactionClient, 'wikiReportCase'> = this.prisma,
  ) {
    const reportCase = await store.wikiReportCase.findUnique({
      where: { id: caseId },
      include: REPORT_INCLUDE,
    });
    if (!reportCase) throw new NotFoundException(CASE_NOT_FOUND_MESSAGE);
    return reportCase;
  }

  private async audit(
    tx: Prisma.TransactionClient,
    action: string,
    session: SessionPayload,
    actorProfileId: bigint,
    reportCase: Prisma.WikiReportCaseGetPayload<{ include: typeof REPORT_INCLUDE }>,
    metadata: Record<string, unknown>,
    createdAt: Date,
  ): Promise<void> {
    await writeAuditRecord(tx, {
      data: {
        category: 'wiki',
        action,
        severity: isFinal(reportCase.status) ? 'warning' : 'info',
        actorAccountId: session.userId,
        actorProfileId,
        subjectType: 'wiki_report_case',
        subjectId: reportCase.id,
        metadata: toAuditJson({
          targetType: reportCase.targetType,
          targetId: reportCase.targetId.toString(),
          pageId: reportCase.pageId.toString(),
          version: reportCase.version,
          ...metadata,
        }),
        createdAt,
      },
    });
  }
}

function toCaseResponse(reportCase: Prisma.WikiReportCaseGetPayload<{ include: typeof REPORT_INCLUDE }>) {
  return {
    id: reportCase.id,
    targetType: reportCase.targetType,
    targetId: reportCase.targetId.toString(),
    pageId: reportCase.pageId.toString(),
    status: reportCase.status,
    reportCount: reportCase.reportCount,
    evidenceSnapshot: reportCase.evidenceSnapshot,
    assigneeProfileId: reportCase.assigneeProfileId?.toString() ?? null,
    assignedAt: reportCase.assignedAt?.toISOString() ?? null,
    resolution: reportCase.resolution,
    version: reportCase.version,
    statusUpdatedAt: reportCase.statusUpdatedAt.toISOString(),
    resolvedAt: reportCase.resolvedAt?.toISOString() ?? null,
    dismissedAt: reportCase.dismissedAt?.toISOString() ?? null,
    createdAt: reportCase.createdAt.toISOString(),
    updatedAt: reportCase.updatedAt.toISOString(),
    recentSubmissions: reportCase.submissions.map((submission) => ({
      id: submission.id,
      reporterProfileId: submission.reporterProfileId?.toString() ?? null,
      reason: submission.reason,
      createdAt: submission.createdAt.toISOString(),
    })),
  };
}

function parseOptionalStatus(value?: string): WikiReportStatus | undefined {
  return value?.trim() ? parseStatus(value) : undefined;
}

function parseStatus(value?: string): WikiReportStatus {
  const status = value?.trim();
  if (!WIKI_REPORT_STATUSES.includes(status as WikiReportStatus)) {
    throw new BadRequestException('Invalid wiki report status.');
  }
  return status as WikiReportStatus;
}

function parseOptionalTargetType(value?: string): WikiReportTargetType | undefined {
  const targetType = value?.trim();
  if (!targetType) return undefined;
  if (!WIKI_REPORT_TARGET_TYPES.includes(targetType as WikiReportTargetType)) {
    throw new BadRequestException('Invalid wiki report target type.');
  }
  return targetType as WikiReportTargetType;
}

function parseProfileOrTargetId(value: string, label: string): bigint {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) throw new BadRequestException(`${label} must be an unsigned integer.`);
  const parsed = BigInt(normalized);
  if (parsed > MAX_UNSIGNED_BIGINT) throw new BadRequestException(`${label} is outside the supported range.`);
  return parsed;
}

function parseExpectedVersion(value?: number): number {
  if (!Number.isInteger(value) || (value ?? 0) < 1 || (value ?? 0) > 2_147_483_647) {
    throw new BadRequestException('expectedVersion must be a positive integer.');
  }
  return value as number;
}

function parseResolution(value?: string): string {
  const resolution = value?.trim() ?? '';
  if (resolution.length < 3 || resolution.length > 1_000) {
    throw new BadRequestException('resolution must contain between 3 and 1000 characters.');
  }
  return resolution;
}

function assertActiveCase(
  reportCase: { readonly status: string } | null,
): asserts reportCase is NonNullable<typeof reportCase> & {
  readonly id: string;
  readonly status: 'open' | 'in_review';
  readonly version: number;
  readonly activeKey: string | null;
  readonly assigneeProfileId: bigint | null;
  readonly assignedAt: Date | null;
} {
  if (!reportCase) throw new NotFoundException(CASE_NOT_FOUND_MESSAGE);
  if (isFinal(reportCase.status)) throw new ConflictException('Final wiki report cases cannot be changed.');
}

function isFinal(status: string): status is 'resolved' | 'dismissed' {
  return status === 'resolved' || status === 'dismissed';
}

function versionConflict(): ConflictException {
  return new ConflictException('The report case version changed. Refresh and try again.');
}

interface QueueCursor {
  readonly snapshotAt: Date;
  readonly createdAt: Date;
  readonly id: string;
}

function encodeCursor(snapshotAt: Date, createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    snapshotAt: snapshotAt.toISOString(),
    createdAt: createdAt.toISOString(),
    id,
  }), 'utf8').toString('base64url');
}

function decodeCursor(value: string): QueueCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      typeof parsed.snapshotAt !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
    ) {
      throw new Error('invalid cursor');
    }
    const snapshotAt = new Date(parsed.snapshotAt);
    const createdAt = new Date(parsed.createdAt);
    if (!Number.isFinite(snapshotAt.getTime()) || !Number.isFinite(createdAt.getTime()) || createdAt > snapshotAt) {
      throw new Error('invalid cursor dates');
    }
    return { snapshotAt, createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid wiki report queue cursor.');
  }
}
