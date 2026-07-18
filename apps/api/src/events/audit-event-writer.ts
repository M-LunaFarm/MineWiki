import { Prisma } from '@prisma/client';
import { getCurrentHttpRequestContext } from '../common/http/request-context';
import type { PrismaService } from '../common/prisma.service';
import { toAuditJson } from './audit-redaction';

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
  readonly createdAt?: Date;
}

export async function writeAuditEvent(
  store: Prisma.TransactionClient | PrismaService,
  action: string,
  input: AuditEventInput = {},
): Promise<void> {
  const context = getCurrentHttpRequestContext();
  await store.auditEvent.create({
    data: {
      category: cleanText(input.category ?? categoryFromAction(action), 64),
      action: cleanText(action, 128),
      severity: cleanText(input.severity ?? 'info', 16),
      actorAccountId: input.actorAccountId ?? null,
      actorProfileId: normalizeBigInt(input.actorProfileId),
      subjectType: input.subjectType ? cleanText(input.subjectType, 64) : null,
      subjectId: normalizeString(input.subjectId, 128),
      requestId: cleanOptional(input.requestId ?? context.requestId, 64),
      ipAddress: cleanOptional(input.ipAddress ?? context.requestIp, 64),
      userAgent: cleanOptional(input.userAgent ?? context.userAgent, 512),
      metadata: input.metadata === undefined ? undefined : toAuditJson(input.metadata),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
}

export async function writeAuditRecord(
  store: Prisma.TransactionClient | PrismaService,
  args: { readonly data: AuditEventInput & { readonly action: string } },
): Promise<void> {
  const { action, ...input } = args.data;
  await writeAuditEvent(store, action, input);
}

function categoryFromAction(action: string): string {
  const parts = action.split('.');
  if (parts[0] === 'discord' && parts[1] === 'verify') return 'discord.verify';
  if (parts[0] === 'plugin' && parts[1] === 'sync') return 'plugin.sync';
  return cleanText(parts[0] || 'system', 64);
}

function cleanText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength) || 'unknown';
}

function cleanOptional(value: string | null | undefined, maxLength: number): string | null {
  const cleaned = value?.trim().slice(0, maxLength);
  return cleaned || null;
}

function normalizeBigInt(value: bigint | number | string | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  try { return BigInt(value); } catch { return null; }
}

function normalizeString(value: string | number | bigint | null | undefined, maxLength: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value).slice(0, maxLength);
}
