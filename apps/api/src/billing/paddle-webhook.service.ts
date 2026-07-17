import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { Prisma } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';

const MAX_WEBHOOK_BYTES = 256 * 1024;
const SUBSCRIPTION_EVENTS = new Set([
  'subscription.created',
  'subscription.updated',
  'subscription.activated',
  'subscription.resumed',
  'subscription.paused',
  'subscription.canceled',
]);

interface PaddleEventEnvelope {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly notificationId: string | null;
  readonly data: Record<string, unknown>;
}

interface SubscriptionProjection {
  readonly id: string;
  readonly customerId: string | null;
  readonly status: string;
  readonly nextBilledAt: Date | null;
  readonly periodStartsAt: Date | null;
  readonly periodEndsAt: Date | null;
  readonly scheduledChange: Prisma.InputJsonValue | null;
  readonly payload: Prisma.InputJsonValue;
}

@Injectable()
export class PaddleWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async ingest(rawBody: Buffer | undefined, signature: string | undefined) {
    if (this.config.get('PADDLE_MODE', 'off') !== 'shadow') {
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
          select: { lastEventOccurredAt: true },
        });
        if (existing && existing.lastEventOccurredAt >= event.occurredAt) {
          await transaction.paddleWebhookEvent.update({
            where: { id: eventRow.id },
            data: { status: 'stale', processedAt: new Date() },
          });
          return { accepted: true, duplicate: false, status: 'stale' as const };
        }

        const subscriptionData = {
          providerCustomerId: projection.customerId,
          status: projection.status,
          nextBilledAt: projection.nextBilledAt,
          currentPeriodStartsAt: projection.periodStartsAt,
          currentPeriodEndsAt: projection.periodEndsAt,
          scheduledChange: projection.scheduledChange ?? Prisma.DbNull,
          lastEventId: event.eventId,
          lastEventOccurredAt: event.occurredAt,
          lastPayload: projection.payload,
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
          data: { status: 'processed', processedAt: new Date() },
        });
        return { accepted: true, duplicate: false, status: 'processed' as const };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
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
}

export function verifyPaddleSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  toleranceSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (!header) throw new UnauthorizedException('Paddle signature is missing.');
  const values = new Map<string, string[]>();
  for (const part of header.split(/[;,]/u)) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    const key = rawKey?.trim();
    const value = rawValue.join('=').trim();
    if (!key || !value) continue;
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const timestamp = Number(values.get('ts')?.[0]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new UnauthorizedException('Paddle signature timestamp is invalid.');
  }
  const expected = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}:`, 'utf8'), rawBody]))
    .digest();
  const valid = (values.get('h1') ?? []).some((candidate) => {
    if (!/^[a-f0-9]{64}$/iu.test(candidate)) return false;
    const actual = Buffer.from(candidate, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  if (!valid) throw new UnauthorizedException('Paddle signature is invalid.');
}

export function parsePaddleEvent(rawBody: Buffer): PaddleEventEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new BadRequestException('Webhook body must be valid JSON.');
  }
  if (!isObject(parsed)) throw new BadRequestException('Webhook body is invalid.');
  const eventId = boundedString(parsed.event_id, 64);
  const eventType = boundedString(parsed.event_type, 64);
  const occurredAt = parseDate(parsed.occurred_at);
  if (!eventId || !eventType || !occurredAt || !isObject(parsed.data)) {
    throw new BadRequestException('Webhook event envelope is invalid.');
  }
  return {
    eventId,
    eventType,
    occurredAt,
    notificationId: boundedString(parsed.notification_id, 64),
    data: parsed.data,
  };
}

function toSubscriptionProjection(event: PaddleEventEnvelope): SubscriptionProjection | null {
  if (!SUBSCRIPTION_EVENTS.has(event.eventType)) return null;
  const id = boundedString(event.data.id, 64);
  const status = boundedString(event.data.status, 32);
  if (!id || !status) throw new BadRequestException('Subscription webhook data is invalid.');
  const period = isObject(event.data.current_billing_period) ? event.data.current_billing_period : null;
  const scheduledChange = summarizeScheduledChange(event.data.scheduled_change);
  return {
    id,
    customerId: boundedString(event.data.customer_id, 64),
    status,
    nextBilledAt: parseOptionalDate(event.data.next_billed_at),
    periodStartsAt: parseOptionalDate(period?.starts_at),
    periodEndsAt: parseOptionalDate(period?.ends_at),
    scheduledChange,
    payload: summarizeSubscriptionData(event.data),
  };
}

function summarizeEvent(event: PaddleEventEnvelope): Prisma.InputJsonValue {
  return asJson({
    event_id: event.eventId,
    event_type: event.eventType,
    occurred_at: event.occurredAt.toISOString(),
    notification_id: event.notificationId,
    data: SUBSCRIPTION_EVENTS.has(event.eventType)
      ? summarizeSubscriptionData(event.data)
      : { id: boundedString(event.data.id, 64) },
  });
}

function summarizeSubscriptionData(data: Record<string, unknown>): Prisma.InputJsonValue {
  const period = isObject(data.current_billing_period) ? data.current_billing_period : null;
  const items = Array.isArray(data.items) ? data.items.slice(0, 50).flatMap((item) => {
    if (!isObject(item)) return [];
    const price = isObject(item.price) ? item.price : null;
    return [{
      id: boundedString(item.id, 64),
      price_id: boundedString(price?.id, 64),
      quantity: typeof item.quantity === 'number' ? item.quantity : null,
    }];
  }) : [];
  return asJson({
    id: boundedString(data.id, 64),
    customer_id: boundedString(data.customer_id, 64),
    status: boundedString(data.status, 32),
    next_billed_at: isoDate(data.next_billed_at),
    current_billing_period: period ? {
      starts_at: isoDate(period.starts_at),
      ends_at: isoDate(period.ends_at),
    } : null,
    scheduled_change: summarizeScheduledChange(data.scheduled_change),
    items,
    custom_data_keys: isObject(data.custom_data) ? Object.keys(data.custom_data).slice(0, 32) : [],
  });
}

function summarizeScheduledChange(value: unknown): Prisma.InputJsonValue | null {
  if (!isObject(value)) return null;
  return asJson({
    action: boundedString(value.action, 32),
    effective_at: isoDate(value.effective_at),
    resume_at: isoDate(value.resume_at),
  });
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseOptionalDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = parseDate(value);
  if (!parsed) throw new BadRequestException('Subscription date is invalid.');
  return parsed;
}

function isoDate(value: unknown): string | null {
  return parseDate(value)?.toISOString() ?? null;
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
