import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import {
  PaddleEntitlementProjectorService,
} from './paddle-entitlement-projector.service';
import {
  parsePaddleEvent,
  summarizeEvent,
  toSubscriptionProjection,
  verifyPaddleSignature,
} from './paddle-webhook-event';

export { parsePaddleEvent, verifyPaddleSignature } from './paddle-webhook-event';

const MAX_WEBHOOK_BYTES = 256 * 1024;

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
    const secret = this.config.get('PADDLE_WEBHOOK_SECRET');
    verifyPaddleSignature(
      rawBody,
      signature,
      secret,
      this.config.getNumber('PADDLE_WEBHOOK_TOLERANCE_SECONDS', 5),
    );
    const event = parsePaddleEvent(rawBody);
    const environment = this.config.get('PADDLE_ENV', 'sandbox');
    const payload = summarizeEvent(event);
    const projection = toSubscriptionProjection(event);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (transaction) => {
        const eventRow = await transaction.paddleWebhookEvent.create({
          data: {
            providerEventId: event.eventId,
            environment,
            eventType: event.eventType,
            occurredAt: event.occurredAt,
            payload,
          },
          select: { id: true },
        });

        if (!projection) {
          await transaction.paddleWebhookEvent.update({
            where: { id: eventRow.id },
            data: { status: 'ignored', processedAt: new Date() },
          });
          return { accepted: true, duplicate: false, status: 'ignored' as const };
        }

        const existing = await transaction.paddleSubscriptionShadow.findUnique({
          where: {
            environment_providerSubscriptionId: {
              environment,
              providerSubscriptionId: projection.id,
            },
          },
          select: {
            billingSubjectId: true,
            providerTransactionId: true,
            lastEventId: true,
            lastEventOccurredAt: true,
          },
        });
        if (existing && existing.lastEventOccurredAt > event.occurredAt) {
          await transaction.paddleWebhookEvent.update({
            where: { id: eventRow.id },
            data: { status: 'stale', processedAt: new Date() },
          });
          return { accepted: true, duplicate: false, status: 'stale' as const };
        }
        if (existing && existing.lastEventOccurredAt.getTime() === event.occurredAt.getTime()) {
          if (existing.lastEventId.toLowerCase() >= event.eventId.toLowerCase()) {
            await transaction.paddleWebhookEvent.update({
              where: { id: eventRow.id },
              data: { status: 'stale', processedAt: new Date(), lastError: 'equal_occurred_at_tie_break' },
            });
            return { accepted: true, duplicate: false, status: 'stale' as const };
          }
        }

        const projectionResult = this.config.get('PADDLE_MODE', 'off') === 'live'
          ? await this.projector.project(transaction, environment, event.eventId, event.occurredAt, projection, existing)
          : {
              billingSubjectId: existing?.billingSubjectId ?? null,
              status: 'shadow' as const,
              error: null,
              projectedAt: null,
            };

        const subscriptionData = {
          billingSubjectId: projectionResult.billingSubjectId,
          providerCustomerId: projection.customerId,
          providerTransactionId: projection.transactionId ?? existing?.providerTransactionId ?? null,
          status: projection.status,
          nextBilledAt: projection.nextBilledAt,
          currentPeriodStartsAt: projection.periodStartsAt,
          currentPeriodEndsAt: projection.periodEndsAt,
          scheduledChange: projection.scheduledChange ?? Prisma.DbNull,
          lastEventId: event.eventId,
          lastEventOccurredAt: event.occurredAt,
          lastPayload: projection.payload,
          projectionStatus: projectionResult.status,
          projectionError: projectionResult.error,
          projectedAt: projectionResult.projectedAt,
        };
        await transaction.paddleSubscriptionShadow.upsert({
          where: {
            environment_providerSubscriptionId: {
              environment,
              providerSubscriptionId: projection.id,
            },
          },
          create: {
            environment,
            providerSubscriptionId: projection.id,
            ...subscriptionData,
          },
          update: subscriptionData,
        });
          await transaction.paddleWebhookEvent.update({
            where: { id: eventRow.id },
            data: {
              status: projectionResult.status === 'quarantined' ? 'quarantined' : 'processed',
              processedAt: new Date(),
              lastError: projectionResult.error,
            },
          });
        return {
          accepted: true,
          duplicate: false,
          status: projectionResult.status === 'quarantined' ? 'quarantined' as const : 'processed' as const,
        };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (prismaCode(error) === 'P2034' && attempt < 3) continue;
        if (isUniqueConstraintError(error)) {
          const duplicate = await this.prisma.paddleWebhookEvent.findUnique({
            where: {
              environment_providerEventId: {
                environment,
                providerEventId: event.eventId,
              },
            },
            select: { status: true },
          });
          if (duplicate) return { accepted: true, duplicate: true, status: duplicate.status };
        }
        throw error;
      }
    }
    throw new Error('Paddle webhook serialization retry exhausted.');
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function prismaCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null;
}
