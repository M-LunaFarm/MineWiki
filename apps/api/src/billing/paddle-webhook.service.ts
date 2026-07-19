import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { PaddleEntitlementProjectorService } from './paddle-entitlement-projector.service';
import {
  parsePaddleEvent,
  summarizeEvent,
  toSubscriptionProjection,
  verifyPaddleSignature,
} from './paddle-webhook-event';

export { parsePaddleEvent, verifyPaddleSignature } from './paddle-webhook-event';

const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_PROCESS_ATTEMPTS = 8;
const PROCESSING_LEASE_MS = 5 * 60 * 1000;
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;
const RETRYABLE_PROJECTION_ERRORS = new Set([
  'checkout_intent_missing',
  'checkout_transaction_missing',
]);

type InboxTerminalStatus = 'ignored' | 'stale' | 'processed' | 'quarantined';

@Injectable()
export class PaddleWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly projector: PaddleEntitlementProjectorService,
  ) {}

  async ingest(rawBody: Buffer | undefined, signature: string | undefined) {
    if (!['shadow', 'live'].includes(this.config.get('PADDLE_MODE', 'off'))) {
      throw new NotFoundException('Webhook endpoint is not enabled.');
    }
    if (!rawBody || rawBody.length === 0 || rawBody.length > MAX_WEBHOOK_BYTES) {
      throw new BadRequestException('Webhook body is missing or too large.');
    }
    const tolerance = this.config.getNumber('PADDLE_WEBHOOK_TOLERANCE_SECONDS', 5);
    try {
      verifyPaddleSignature(rawBody, signature, this.config.get('PADDLE_WEBHOOK_SECRET'), tolerance);
    } catch (error) {
      const previous = this.config.getOptional('PADDLE_WEBHOOK_SECRET_PREVIOUS');
      if (!previous) throw error;
      verifyPaddleSignature(rawBody, signature, previous, tolerance);
    }
    const event = parsePaddleEvent(rawBody);
    const environment = this.config.get('PADDLE_ENV', 'sandbox');
    const projection = toSubscriptionProjection(event);
    try {
      await this.prisma.paddleWebhookEvent.create({
        data: {
          providerEventId: event.eventId,
          providerSubscriptionId: projection?.id ?? null,
          environment,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          occurredAtRaw: event.occurredAtRaw,
          payload: summarizeEvent(event),
          status: 'received',
          attempts: 0,
          availableAt: new Date(),
        },
        select: { id: true },
      });
      return { accepted: true, duplicate: false, status: 'received' as const };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const duplicate = await this.prisma.paddleWebhookEvent.findUnique({
        where: { environment_providerEventId: { environment, providerEventId: event.eventId } },
        select: { status: true },
      });
      if (!duplicate) throw error;
      return { accepted: true, duplicate: true, status: duplicate.status };
    }
  }

  async processDue(limitInput = 25, now = new Date()) {
    const limit = Number(limitInput);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('Paddle inbox limit must be between 1 and 100.');
    }
    const staleLeaseAt = new Date(now.getTime() - PROCESSING_LEASE_MS);
    const candidates = await this.prisma.paddleWebhookEvent.findMany({
      where: {
        OR: [
          { status: { in: ['received', 'retry'] }, availableAt: { lte: now } },
          { status: 'processing', lockedAt: { lte: staleLeaseAt } },
        ],
      },
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, attempts: true },
    });
    const result = { examined: candidates.length, processed: 0, ignored: 0, stale: 0, quarantined: 0, retried: 0, deadLettered: 0, skipped: 0 };
    for (const candidate of candidates) {
      const workerId = randomUUID();
      const claimed = await this.prisma.paddleWebhookEvent.updateMany({
        where: {
          id: candidate.id,
          OR: [
            { status: { in: ['received', 'retry'] }, availableAt: { lte: now } },
            { status: 'processing', lockedAt: { lte: staleLeaseAt } },
          ],
        },
        data: { status: 'processing', lockedAt: now, lockedBy: workerId, attempts: { increment: 1 } },
      });
      if (claimed.count !== 1) {
        result.skipped += 1;
        continue;
      }
      const attempt = candidate.attempts + 1;
      try {
        const status = await this.processClaimed(candidate.id, workerId);
        result[status === 'processed' ? 'processed' : status] += 1;
      } catch (error) {
        const permanent = error instanceof PermanentPaddleInboxError;
        const exhausted = attempt >= MAX_PROCESS_ATTEMPTS;
        const status = permanent ? 'quarantined' : exhausted ? 'dead_letter' : 'retry';
        const retryAt = new Date(now.getTime() + retryDelayMs(attempt));
        await this.prisma.paddleWebhookEvent.updateMany({
          where: { id: candidate.id, status: 'processing', lockedBy: workerId },
          data: {
            status,
            availableAt: status === 'retry' ? retryAt : now,
            lockedAt: null,
            lockedBy: null,
            processedAt: permanent ? now : null,
            deadLetteredAt: exhausted && !permanent ? now : null,
            lastError: truncateError(error),
          },
        });
        if (permanent) result.quarantined += 1;
        else if (exhausted) result.deadLettered += 1;
        else result.retried += 1;
      }
    }
    return result;
  }

  private async processClaimed(eventRowId: bigint, workerId: string): Promise<InboxTerminalStatus> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (transaction) => {
          const eventRow = await transaction.paddleWebhookEvent.findUnique({ where: { id: eventRowId } });
          if (!eventRow || eventRow.status !== 'processing' || eventRow.lockedBy !== workerId) {
            throw new PermanentPaddleInboxError('paddle_inbox_lease_lost');
          }
          let event;
          try {
            event = parsePaddleEvent(Buffer.from(JSON.stringify(eventRow.payload), 'utf8'));
          } catch (error) {
            throw new PermanentPaddleInboxError(`stored_payload_invalid:${truncateError(error)}`);
          }
          const projection = toSubscriptionProjection(event);
          if (!projection) {
            await finishEvent(transaction, eventRow.id, 'ignored', null);
            return 'ignored';
          }

          const existing = await transaction.paddleSubscriptionShadow.findUnique({
            where: {
              environment_providerSubscriptionId: {
                environment: eventRow.environment,
                providerSubscriptionId: projection.id,
              },
            },
            select: {
              billingSubjectId: true,
              providerTransactionId: true,
              lastEventOccurredAt: true,
              lastEventOccurredAtRaw: true,
            },
          });
          if (existing) {
            const ordering = compareOccurredAt(
              existing.lastEventOccurredAt,
              existing.lastEventOccurredAtRaw ?? existing.lastEventOccurredAt.toISOString(),
              eventRow.occurredAt,
              eventRow.occurredAtRaw,
            );
            if (ordering > 0) {
              await finishEvent(transaction, eventRow.id, 'stale', null);
              return 'stale';
            }
            if (ordering === 0) {
              await finishEvent(transaction, eventRow.id, 'quarantined', 'equal_occurred_at_requires_reconciliation');
              return 'quarantined';
            }
          }

          const projectionResult = this.config.get('PADDLE_MODE', 'off') === 'live'
            ? await this.projector.project(
                transaction,
                eventRow.environment,
                eventRow.providerEventId,
                eventRow.occurredAt,
                projection,
                existing,
              )
            : { billingSubjectId: existing?.billingSubjectId ?? null, status: 'shadow' as const, error: null, projectedAt: null };
          if (projectionResult.status === 'quarantined' && projectionResult.error && RETRYABLE_PROJECTION_ERRORS.has(projectionResult.error)) {
            throw new Error(`retryable_projection:${projectionResult.error}`);
          }

          const subscriptionData = {
            billingSubjectId: projectionResult.billingSubjectId,
            providerCustomerId: projection.customerId,
            providerTransactionId: projection.transactionId ?? existing?.providerTransactionId ?? null,
            status: projection.status,
            nextBilledAt: projection.nextBilledAt,
            currentPeriodStartsAt: projection.periodStartsAt,
            currentPeriodEndsAt: projection.periodEndsAt,
            scheduledChange: projection.scheduledChange ?? Prisma.DbNull,
            lastEventId: eventRow.providerEventId,
            lastEventOccurredAt: eventRow.occurredAt,
            lastEventOccurredAtRaw: eventRow.occurredAtRaw,
            lastPayload: projection.payload,
            projectionStatus: projectionResult.status,
            projectionError: projectionResult.error,
            projectedAt: projectionResult.projectedAt,
          };
          await transaction.paddleSubscriptionShadow.upsert({
            where: {
              environment_providerSubscriptionId: {
                environment: eventRow.environment,
                providerSubscriptionId: projection.id,
              },
            },
            create: { environment: eventRow.environment, providerSubscriptionId: projection.id, ...subscriptionData },
            update: subscriptionData,
          });
          const status = projectionResult.status === 'quarantined' ? 'quarantined' : 'processed';
          await finishEvent(transaction, eventRow.id, status, projectionResult.error);
          return status;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (prismaCode(error) === 'P2034' && attempt < 3) continue;
        throw error;
      }
    }
    throw new Error('Paddle webhook serialization retry exhausted.');
  }
}

async function finishEvent(
  transaction: Prisma.TransactionClient,
  id: bigint,
  status: InboxTerminalStatus,
  lastError: string | null,
): Promise<void> {
  await transaction.paddleWebhookEvent.update({
    where: { id },
    data: { status, processedAt: new Date(), lockedAt: null, lockedBy: null, lastError },
  });
}

function compareOccurredAt(left: Date, leftRaw: string, right: Date, rightRaw: string): number {
  if (left.getTime() !== right.getTime()) return left.getTime() > right.getTime() ? 1 : -1;
  const leftRemainder = subMillisecondNanoseconds(leftRaw);
  const rightRemainder = subMillisecondNanoseconds(rightRaw);
  if (leftRemainder === rightRemainder) return 0;
  return leftRemainder > rightRemainder ? 1 : -1;
}

function subMillisecondNanoseconds(value: string): number {
  const fraction = /\.(\d{1,9})(?:Z|[+-]\d{2}:?\d{2})$/u.exec(value)?.[1] ?? '';
  return Number(fraction.padEnd(9, '0').slice(3, 9) || '0');
}

function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)), RETRY_MAX_MS);
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [...message]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .slice(0, 2_000);
}

class PermanentPaddleInboxError extends Error {}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function prismaCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null;
}
