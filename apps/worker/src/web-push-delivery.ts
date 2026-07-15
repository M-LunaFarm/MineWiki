import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import webPush, { type PushSubscription } from 'web-push';
import { decryptStoredSecret } from './stored-secret';

const BATCH_SIZE = 25;
const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const MAX_RETRY_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

class StoredPushSecretError extends Error {}

export interface WebPushDeliveryConfig {
  enabled: boolean;
  publicKey: string;
  privateKey: string;
  subject: string;
}

interface PushResponse {
  statusCode: number;
  headers?: Record<string, string | string[] | undefined>;
}

interface WebPushDeliveryOptions {
  now?: Date;
  workerId?: string;
  random?: () => number;
  send?: (subscription: PushSubscription, payload: string, options: { timeout: number; topic: string }) => Promise<PushResponse>;
}

export interface WebPushDeliveryResult {
  delivered: number;
  retried: number;
  failed: number;
  removedSubscriptions: number;
}

export function createWebPushSender(config: WebPushDeliveryConfig) {
  if (config.enabled) {
    webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  }
  return (subscription: PushSubscription, payload: string, options: { timeout: number; topic: string }) =>
    webPush.sendNotification(subscription, payload, options);
}

export async function processWebPushDeliveries(
  prisma: PrismaClient,
  config: WebPushDeliveryConfig,
  options: WebPushDeliveryOptions = {},
): Promise<WebPushDeliveryResult> {
  const result: WebPushDeliveryResult = { delivered: 0, retried: 0, failed: 0, removedSubscriptions: 0 };
  if (!config.enabled) return result;

  const now = options.now ?? new Date();
  const workerId = options.workerId ?? `wiki-push-${randomUUID()}`;
  const random = options.random ?? Math.random;
  const send = options.send ?? createWebPushSender(config);

  await prisma.wikiPushDelivery.updateMany({
    where: { status: 'processing', lockedAt: { lt: new Date(now.getTime() - LEASE_MS) } },
    data: { status: 'pending', lockedAt: null, lockedBy: null, availableAt: now },
  });
  const candidates = await prisma.wikiPushDelivery.findMany({
    where: { status: 'pending', availableAt: { lte: now }, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: [{ id: 'asc' }],
    take: BATCH_SIZE,
    select: { id: true },
  });

  for (const candidate of candidates) {
    const claimToken = `${workerId}:${randomUUID()}`;
    const claimed = await prisma.wikiPushDelivery.updateMany({
      where: { id: candidate.id, status: 'pending', availableAt: { lte: now }, attempts: { lt: MAX_ATTEMPTS } },
      data: { status: 'processing', lockedAt: now, lockedBy: claimToken, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;

    const delivery = await prisma.wikiPushDelivery.findUnique({
      where: { id: candidate.id },
      include: {
        subscription: {
          include: {
            session: { include: { account: { select: { lifecycleStatus: true } } } },
            profile: { select: { accountId: true, status: true } },
          },
        },
      },
    });
    if (!delivery || delivery.lockedBy !== claimToken) continue;

    const subscription = delivery.subscription;
    const invalidOwner = subscription.disabledAt !== null
      || (subscription.expirationTime !== null && subscription.expirationTime <= now)
      || subscription.session.expiresAt <= now
      || subscription.session.account.lifecycleStatus !== 'active'
      || subscription.profile.status !== 'active'
      || subscription.profile.accountId !== subscription.session.accountId;
    if (invalidOwner) {
      await prisma.wikiPushSubscription.deleteMany({ where: { id: subscription.id } });
      result.removedSubscriptions += 1;
      continue;
    }

    try {
      const endpoint = requireDecryptedSecret(subscription.endpointCiphertext);
      const p256dh = requireDecryptedSecret(subscription.p256dhCiphertext);
      const auth = requireDecryptedSecret(subscription.authCiphertext);
      const payload = JSON.stringify({
        notificationId: delivery.notificationId.toString(),
        tag: `minewiki-notification-${delivery.notificationId.toString()}`,
      });
      await send(
        { endpoint, expirationTime: subscription.expirationTime?.getTime() ?? null, keys: { p256dh, auth } },
        payload,
        { timeout: REQUEST_TIMEOUT_MS, topic: 'minewiki-notification' },
      );
      const completed = await prisma.wikiPushDelivery.updateMany({
        where: { id: delivery.id, status: 'processing', lockedBy: claimToken },
        data: { status: 'delivered', deliveredAt: new Date(), lockedAt: null, lockedBy: null, lastError: null },
      });
      if (completed.count === 1) {
        await prisma.wikiPushSubscription.updateMany({
          where: { id: subscription.id },
          data: { lastSuccessAt: new Date(), lastFailureAt: null, failureCount: 0 },
        });
        result.delivered += 1;
      }
    } catch (error) {
      const statusCode = getStatusCode(error);
      if (statusCode === 400 || statusCode === 404 || statusCode === 410 || isStoredSecretError(error)) {
        await prisma.wikiPushSubscription.deleteMany({ where: { id: subscription.id } });
        result.removedSubscriptions += 1;
        continue;
      }

      const retryable = statusCode === null || statusCode === 429 || statusCode >= 500;
      const exhausted = delivery.attempts >= MAX_ATTEMPTS;
      const shouldRetry = retryable && !exhausted;
      const retryAfterMs = statusCode === 429 ? getRetryAfterMs(error, now) : null;
      const availableAt = new Date(now.getTime() + (retryAfterMs ?? backoffMs(delivery.attempts, random)));
      await prisma.$transaction([
        prisma.wikiPushDelivery.updateMany({
          where: { id: delivery.id, status: 'processing', lockedBy: claimToken },
          data: {
            status: shouldRetry ? 'pending' : 'failed',
            availableAt,
            lockedAt: null,
            lockedBy: null,
            lastError: sanitizePushError(error),
          },
        }),
        prisma.wikiPushSubscription.updateMany({
          where: { id: subscription.id },
          data: { lastFailureAt: new Date(), failureCount: { increment: 1 } },
        }),
      ]);
      if (shouldRetry) result.retried += 1;
      else result.failed += 1;
    }
  }

  return result;
}

function requireDecryptedSecret(value: string): string {
  try {
    const decrypted = decryptStoredSecret(value);
    if (!decrypted) throw new StoredPushSecretError();
    return decrypted;
  } catch (error) {
    if (error instanceof StoredPushSecretError) throw error;
    throw new StoredPushSecretError();
  }
}

function getStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('statusCode' in error)) return null;
  const statusCode = Number((error as { statusCode?: unknown }).statusCode);
  return Number.isInteger(statusCode) ? statusCode : null;
}

function isStoredSecretError(error: unknown): boolean {
  return error instanceof StoredPushSecretError;
}

function getRetryAfterMs(error: unknown, now: Date): number | null {
  if (!error || typeof error !== 'object' || !('headers' in error)) return null;
  const headers = (error as { headers?: Record<string, string | string[] | undefined> }).headers;
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  if (/^\d+$/.test(value)) return Math.min(MAX_RETRY_MS, Number(value) * 1000);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.min(MAX_RETRY_MS, Math.max(0, date.getTime() - now.getTime()));
}

function backoffMs(attempts: number, random: () => number): number {
  const base = Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.min(attempts, 12));
  return Math.round(base * (0.75 + random() * 0.5));
}

function sanitizePushError(error: unknown): string {
  const statusCode = getStatusCode(error);
  if (statusCode !== null) return `http_${statusCode}`;
  if (error instanceof Error && /timeout/i.test(error.name)) return 'network_timeout';
  return 'network_error';
}
