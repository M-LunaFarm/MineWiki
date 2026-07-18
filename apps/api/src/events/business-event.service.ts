import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  trackEvent,
  type AnalyticsEventName,
  type AnalyticsEventPayloadMap
} from '@minewiki/analytics';
import { Logger } from '@minewiki/logger';
import { PrismaService } from '../common/prisma.service';
import { redactAuditValue } from './audit-redaction';
import { writeAuditEvent, type AuditEventInput } from './audit-event-writer';

export { redactAuditValue, toAuditJson } from './audit-redaction';

export interface AuditEventResponse {
  readonly id: string;
  readonly category: string;
  readonly action: string;
  readonly severity: string;
  readonly actorAccountId: string | null;
  readonly actorProfileId: string | null;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly requestId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly metadata: Prisma.JsonValue | null;
  readonly createdAt: string;
}

export interface AuditEventPage {
  readonly items: AuditEventResponse[];
  readonly nextCursor: string | null;
}

export interface AuditEventPageInput {
  readonly category?: string;
  readonly action?: string;
  readonly severity?: string;
  readonly actorAccountId?: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly requestId?: string;
  readonly cursor?: string;
  readonly limit?: string | number;
  readonly includeSensitive?: boolean;
}

@Injectable()
export class BusinessEventService {
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async track<Name extends AnalyticsEventName>(
    name: Name,
    payload: AnalyticsEventPayloadMap[Name]
  ): Promise<void> {
    await trackEvent(name, payload);
    await this.audit(name, {
      metadata: payload
    });
  }

  async audit(action: string, input: AuditEventInput = {}): Promise<void> {
    if (!this.prisma) {
      return;
    }
    try {
      await writeAuditEvent(this.prisma, action, input);
    } catch (error) {
      Logger.warn({ err: error, action }, 'Failed to persist audit event');
    }
  }

  async listAuditEvents(input: {
    readonly category?: string;
    readonly action?: string;
    readonly limit?: string | number;
    readonly includeSensitive?: boolean;
  } = {}): Promise<AuditEventResponse[]> {
    if (!this.prisma) {
      return [];
    }
    const limit = Math.min(Math.max(Number(input.limit ?? 100) || 100, 1), 200);
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        category: input.category?.trim() || undefined,
        action: input.action?.trim() || undefined
      },
      orderBy: [{ createdAt: 'desc' }],
      take: limit
    });
    return rows.map((row) => toAuditEventResponse(row, input.includeSensitive === true));
  }

  async listAuditEventPage(input: AuditEventPageInput = {}): Promise<AuditEventPage> {
    if (!this.prisma) return { items: [], nextCursor: null };
    const limit = Math.min(Math.max(Number(input.limit ?? 50) || 50, 1), 100);
    const cursor = input.cursor?.trim();
    if (cursor && !await this.prisma.auditEvent.findUnique({ where: { id: cursor }, select: { id: true } })) {
      throw new BadRequestException({ code: 'audit_cursor_invalid', message: '감사 이벤트 커서가 유효하지 않습니다.' });
    }
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        category: exactFilter(input.category),
        action: input.action?.trim() ? { contains: input.action.trim() } : undefined,
        severity: exactFilter(input.severity),
        actorAccountId: exactFilter(input.actorAccountId),
        subjectType: exactFilter(input.subjectType),
        subjectId: exactFilter(input.subjectId),
        requestId: exactFilter(input.requestId),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: pageRows.map((row) => toAuditEventResponse(row, input.includeSensitive === true)),
      nextCursor: hasMore ? pageRows.at(-1)?.id ?? null : null,
    };
  }
}

function exactFilter(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function toAuditEventResponse(row: {
  id: string;
  category: string;
  action: string;
  severity: string;
  actorAccountId: string | null;
  actorProfileId: bigint | null;
  subjectType: string | null;
  subjectId: string | null;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
}, includeSensitive = false): AuditEventResponse {
  return {
    id: row.id,
    category: row.category,
    action: row.action,
    severity: row.severity,
    actorAccountId: row.actorAccountId,
    actorProfileId: row.actorProfileId?.toString() ?? null,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    requestId: row.requestId,
    ipAddress: includeSensitive ? row.ipAddress : null,
    userAgent: includeSensitive ? row.userAgent : null,
    metadata: redactAuditValue(row.metadata) as Prisma.JsonValue | null,
    createdAt: row.createdAt.toISOString(),
  };
}
