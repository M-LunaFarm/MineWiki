import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaddleSubscriptionSnapshot } from './paddle-entitlement-projector.service';

const SUBSCRIPTION_EVENTS = new Set([
  'subscription.created', 'subscription.updated', 'subscription.activated',
  'subscription.resumed', 'subscription.paused', 'subscription.canceled',
]);

export interface PaddleEventEnvelope {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly notificationId: string | null;
  readonly data: Record<string, unknown>;
}

export interface PaddleSubscriptionProjection extends PaddleSubscriptionSnapshot {
  readonly id: string;
  readonly scheduledChange: Prisma.InputJsonValue | null;
  readonly payload: Prisma.InputJsonValue;
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
  const eventId = providerId(parsed.event_id, 'evt_');
  const eventType = boundedString(parsed.event_type, 64);
  const occurredAt = parseDate(parsed.occurred_at);
  if (!eventId || !eventType || !occurredAt || !isObject(parsed.data)) {
    throw new BadRequestException('Webhook event envelope is invalid.');
  }
  return {
    eventId,
    eventType,
    occurredAt,
    notificationId: parsed.notification_id === null ? null : providerId(parsed.notification_id, 'ntf_'),
    data: parsed.data,
  };
}

export function toSubscriptionProjection(event: PaddleEventEnvelope): PaddleSubscriptionProjection | null {
  if (!SUBSCRIPTION_EVENTS.has(event.eventType)) return null;
  const id = providerId(event.data.id, 'sub_');
  const status = boundedString(event.data.status, 32);
  if (!id || !status) throw new BadRequestException('Subscription webhook data is invalid.');
  const period = isObject(event.data.current_billing_period) ? event.data.current_billing_period : null;
  const customData = isObject(event.data.custom_data) ? event.data.custom_data : null;
  return {
    id,
    subscriptionId: id,
    customerId: event.data.customer_id === null ? null : providerId(event.data.customer_id, 'ctm_'),
    transactionId: event.data.transaction_id === null || event.data.transaction_id === undefined
      ? null : providerId(event.data.transaction_id, 'txn_'),
    status,
    nextBilledAt: parseOptionalDate(event.data.next_billed_at),
    periodStartsAt: parseOptionalDate(period?.starts_at),
    periodEndsAt: parseOptionalDate(period?.ends_at),
    scheduledChange: summarizeScheduledChange(event.data.scheduled_change),
    checkoutIntentId: boundedString(customData?.minewiki_checkout_intent_id, 64),
    items: subscriptionItems(event.data),
    payload: summarizeSubscriptionData(event.data),
  };
}

export function summarizeEvent(event: PaddleEventEnvelope): Prisma.InputJsonValue {
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
  const customData = isObject(data.custom_data) ? data.custom_data : null;
  return asJson({
    id: boundedString(data.id, 64),
    customer_id: boundedString(data.customer_id, 64),
    status: boundedString(data.status, 32),
    next_billed_at: isoDate(data.next_billed_at),
    current_billing_period: period ? { starts_at: isoDate(period.starts_at), ends_at: isoDate(period.ends_at) } : null,
    scheduled_change: summarizeScheduledChange(data.scheduled_change),
    items: subscriptionItems(data).map((item) => ({ price_id: item.priceId, quantity: item.quantity })),
    custom_data: { minewiki_checkout_intent_id: boundedString(customData?.minewiki_checkout_intent_id, 64) },
  });
}

function subscriptionItems(data: Record<string, unknown>): PaddleSubscriptionSnapshot['items'] {
  if (!Array.isArray(data.items)) return [];
  return data.items.slice(0, 50).flatMap((item) => {
    if (!isObject(item)) return [];
    const price = isObject(item.price) ? item.price : null;
    return [{
      priceId: providerId(price?.id, 'pri_'),
      quantity: typeof item.quantity === 'number' && Number.isSafeInteger(item.quantity) ? item.quantity : null,
    }];
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

function isoDate(value: unknown): string | null { return parseDate(value)?.toISOString() ?? null; }

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function providerId(value: unknown, prefix: string): string | null {
  const normalized = boundedString(value, 64);
  return normalized && normalized.startsWith(prefix) && /^[a-z0-9_]+$/u.test(normalized) ? normalized : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
