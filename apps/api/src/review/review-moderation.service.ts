import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import { RoleService } from '../roles/role.service';

export type ReviewReportStatus = 'open' | 'in_review' | 'resolved' | 'dismissed';

export interface ReviewReportListQuery {
  readonly status?: ReviewReportStatus;
  readonly serverId?: string;
  readonly assigneeAccountId?: string | null;
  readonly search?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface ReviewReportResolutionInput {
  readonly resolution: string;
  readonly hideReview: boolean;
}

const REPORT_INCLUDE = {
  review: {
    select: {
      id: true,
      serverId: true,
      authorDisplayName: true,
      body: true,
      visibility: true,
      reports: true,
      createdAt: true,
      server: { select: { id: true, name: true } },
    },
  },
  reporter: { select: { id: true, displayName: true, email: true } },
  assignee: { select: { id: true, displayName: true, email: true } },
} satisfies Prisma.ReviewReportInclude;

@Injectable()
export class ReviewModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RoleService,
    private readonly events: BusinessEventService,
  ) {}

  async listReports(query: ReviewReportListQuery) {
    const where: Prisma.ReviewReportWhereInput = {
      status: query.status,
      assigneeAccountId:
        query.assigneeAccountId === null
          ? null
          : query.assigneeAccountId || undefined,
      review: query.serverId ? { serverId: query.serverId } : undefined,
    };

    if (query.search) {
      where.AND = [
        {
          OR: [
            { reason: { contains: query.search } },
            { review: { body: { contains: query.search } } },
            { review: { authorDisplayName: { contains: query.search } } },
          ],
        },
      ];
    }

    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.reviewReport.findMany({
        where,
        include: REPORT_INCLUDE,
        orderBy: [{ statusUpdatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take: query.pageSize,
      }),
      this.prisma.reviewReport.count({ where }),
    ]);

    return {
      items: items.map(toReportResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
    };
  }

  async assign(reportId: string, actorAccountId: string, assigneeAccountId: string) {
    await this.assertAssignableModerator(assigneeAccountId);
    const existing = await this.prisma.reviewReport.findUnique({ where: { id: reportId } });
    if (!existing) {
      throw new NotFoundException('리뷰 신고를 찾을 수 없습니다.');
    }
    if (isFinal(existing.status)) {
      throw new ConflictException('종결된 리뷰 신고는 다시 배정할 수 없습니다.');
    }

    const now = new Date();
    const claimed = await this.prisma.reviewReport.updateMany({
      where: {
        id: reportId,
        status: existing.status,
        statusUpdatedAt: existing.statusUpdatedAt,
      },
      data: {
        assigneeAccountId,
        assignedAt: now,
        status: 'in_review',
        statusUpdatedAt: now,
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException('다른 운영자가 먼저 신고 상태를 변경했습니다.');
    }
    const updated = await this.prisma.reviewReport.findUnique({
      where: { id: reportId },
      include: REPORT_INCLUDE,
    });
    if (!updated) {
      throw new NotFoundException('리뷰 신고를 찾을 수 없습니다.');
    }
    await this.events.audit('review.report.assigned', {
      category: 'review',
      actorAccountId,
      subjectType: 'review_report',
      subjectId: reportId,
      metadata: {
        assigneeAccountId,
        previousStatus: existing.status,
        nextStatus: 'in_review',
        reviewId: existing.reviewId,
      },
    });
    return toReportResponse(updated);
  }

  async resolve(
    reportId: string,
    actorAccountId: string,
    status: Extract<ReviewReportStatus, 'resolved' | 'dismissed'>,
    input: ReviewReportResolutionInput,
  ) {
    const now = new Date();
    const result = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.reviewReport.findUnique({
        where: { id: reportId },
        include: { review: { select: { id: true, serverId: true, visibility: true } } },
      });
      if (!existing) {
        throw new NotFoundException('리뷰 신고를 찾을 수 없습니다.');
      }
      if (isFinal(existing.status)) {
        throw new ConflictException('이미 종결된 리뷰 신고입니다.');
      }

      const claimed = await transaction.reviewReport.updateMany({
        where: {
          id: reportId,
          status: existing.status,
          statusUpdatedAt: existing.statusUpdatedAt,
        },
        data: {
          status,
          resolution: input.resolution,
          assigneeAccountId: existing.assigneeAccountId ?? actorAccountId,
          assignedAt: existing.assignedAt ?? now,
          statusUpdatedAt: now,
          resolvedAt: status === 'resolved' ? now : null,
          dismissedAt: status === 'dismissed' ? now : null,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('다른 운영자가 먼저 신고 상태를 변경했습니다.');
      }

      let reviewHidden = false;
      if (input.hideReview) {
        const hidden = await transaction.serverReview.updateMany({
          where: { id: existing.review.id, visibility: 'public' },
          data: { visibility: 'staff' },
        });
        if (hidden.count === 1) {
          const counter = await transaction.server.updateMany({
            where: { id: existing.review.serverId, reviewsCount: { gt: 0 } },
            data: { reviewsCount: { decrement: 1 } },
          });
          if (counter.count !== 1) {
            throw new InternalServerErrorException(
              '공개 리뷰 집계가 일치하지 않아 신고 처리를 중단했습니다.',
            );
          }
          reviewHidden = true;
        }
      }

      const updated = await transaction.reviewReport.findUnique({
        where: { id: reportId },
        include: REPORT_INCLUDE,
      });
      if (!updated) {
        throw new NotFoundException('리뷰 신고를 찾을 수 없습니다.');
      }
      return { existing, updated, reviewHidden };
    });

    await this.events.audit(`review.report.${status}`, {
      category: 'review',
      severity: status === 'resolved' ? 'warning' : 'info',
      actorAccountId,
      subjectType: 'review_report',
      subjectId: reportId,
      metadata: {
        previousStatus: result.existing.status,
        nextStatus: status,
        reviewId: result.existing.review.id,
        serverId: result.existing.review.serverId,
        reviewHidden: result.reviewHidden,
      },
    });
    return toReportResponse(result.updated);
  }

  private async assertAssignableModerator(accountId: string): Promise<void> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true },
    });
    if (!account) {
      throw new NotFoundException('배정할 운영자 계정을 찾을 수 없습니다.');
    }
    const access = await this.roles.getAccountAccess(accountId);
    if (
      !access.permissions.includes('review.moderate') &&
      !access.roles.some((role) => role === 'owner' || role === 'admin')
    ) {
      throw new ForbiddenException('리뷰 신고 처리 권한이 없는 계정에는 배정할 수 없습니다.');
    }
  }
}

function isFinal(status: string): boolean {
  return status === 'resolved' || status === 'dismissed';
}

function toReportResponse(report: Prisma.ReviewReportGetPayload<{ include: typeof REPORT_INCLUDE }>) {
  return {
    id: report.id,
    reason: report.reason,
    status: report.status,
    resolution: report.resolution,
    assignedAt: report.assignedAt?.toISOString() ?? null,
    statusUpdatedAt: report.statusUpdatedAt.toISOString(),
    resolvedAt: report.resolvedAt?.toISOString() ?? null,
    dismissedAt: report.dismissedAt?.toISOString() ?? null,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString(),
    reporter: {
      id: report.reporter.id,
      displayName: report.reporter.displayName,
      email: report.reporter.email,
    },
    assignee: report.assignee
      ? {
          id: report.assignee.id,
          displayName: report.assignee.displayName,
          email: report.assignee.email,
        }
      : null,
    review: {
      id: report.review.id,
      serverId: report.review.serverId,
      serverName: report.review.server.name,
      authorDisplayName: report.review.authorDisplayName,
      body: report.review.body,
      visibility: report.review.visibility,
      reports: report.review.reports,
      createdAt: report.review.createdAt.toISOString(),
    },
  };
}
