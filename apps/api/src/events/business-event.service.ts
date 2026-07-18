import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  trackEvent,
  type AnalyticsEventName,
  type AnalyticsEventPayloadMap
} from '@minewiki/analytics';
import { Logger } from '@minewiki/logger';
import { PrismaService } from '../common/prisma.service';

const REDACTED = '[redacted]';
const SENSITIVE_KEY_PATTERN = /(authorization|token|secret|password|credential|cookie)/i;

export interface AuditEventInput {
  readonly category?: string;
  readonly severity?: 'info' | 'warning' | 'error' | 'critical';
  readonly actorAccountId?: string | null;
  readonly actorProfileId?: bigint | number | string | null;
  readonly subjectType?: string | null;
  readonly subjectId?: string | number | bigint | null;
  readonly requestId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly metadata?: unknown;
}

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
      category: categoryFromAction(name),
      metadata: payload
    });
  }

  async audit(action: string, input: AuditEventInput = {}): Promise<void> {
    if (!this.prisma) {
      return;
    }
    try {
      await this.prisma.auditEvent.create({
        data: {
          category: cleanText(input.category ?? categoryFromAction(action), 64),
          action: cleanText(action, 128),
          severity: cleanText(input.severity ?? 'info', 16),
          actorAccountId: input.actorAccountId ?? null,
          actorProfileId: normalizeBigInt(input.actorProfileId),
          subjectType: input.subjectType ? cleanText(input.subjectType, 64) : null,
          subjectId: normalizeString(input.subjectId, 128),
          requestId: input.requestId ? cleanText(input.requestId, 64) : null,
          ipAddress: input.ipAddress ? cleanText(input.ipAddress, 64) : null,
          userAgent: input.userAgent ? cleanText(input.userAgent, 512) : null,
          metadata: input.metadata === undefined ? undefined : toAuditJson(input.metadata)
        }
      });
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

export function toAuditJson(value: unknown): Prisma.InputJsonValue {
  return redactAuditValue(value) as Prisma.InputJsonValue;
}

export function redactAuditValue(value: unknown): unknown {
  return redactValue(value);
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return REDACTED;
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = redactValue(entryValue, entryKey);
    }
    return output;
  }
  if (typeof value === 'string') {
    return sanitizeStringValue(value);
  }
  if (['number', 'boolean'].includes(typeof value)) {
    return value;
  }
  return String(value);
}

function sanitizeStringValue(value: string): string {
  if (!/[?&](verifyToken|completionToken|token|secret|access_token|refresh_token)=/i.test(value)) {
    return value;
  }
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY_PATTERN.test(key) || key === 'access_token' || key === 'refresh_token') {
        parsed.searchParams.set(key, REDACTED);
      }
    }
    return parsed.toString();
  } catch {
    return value.replace(
      /([?&][^=]*(?:token|secret|authorization|access_token|refresh_token)[^=]*=)([^&]+)/gi,
      `$1${encodeURIComponent(REDACTED)}`
    );
  }
}

function categoryFromAction(action: string): string {
  const parts = action.split('.');
  if (parts[0] === 'discord' && parts[1] === 'verify') {
    return 'discord.verify';
  }
  if (parts[0] === 'plugin' && parts[1] === 'sync') {
    return 'plugin.sync';
  }
  return cleanText(parts[0] || 'system', 64);
}

function cleanText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength) || 'unknown';
}

function normalizeBigInt(value: bigint | number | string | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function normalizeString(value: string | number | bigint | null | undefined, maxLength: number): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value).slice(0, maxLength);
}
