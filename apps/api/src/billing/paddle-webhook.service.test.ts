import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PaddleWebhookService, parsePaddleEvent, verifyPaddleSignature } from './paddle-webhook.service';

const secret = 'pdl_ntfset_test_secret';

test('Paddle signature verification binds timestamp and exact raw bytes', () => {
  const raw = eventBody('evt_signature', '2026-07-17T00:00:00.000Z');
  const timestamp = 1_784_246_400;
  const header = signature(raw, timestamp);

  assert.doesNotThrow(() => verifyPaddleSignature(raw, header, secret, 5, timestamp));
  assert.throws(() => verifyPaddleSignature(Buffer.concat([raw, Buffer.from(' ')]), header, secret, 5, timestamp), /signature is invalid/);
  assert.throws(() => verifyPaddleSignature(raw, header, secret, 5, timestamp + 6), /timestamp is invalid/);
  assert.throws(() => verifyPaddleSignature(raw, undefined, secret, 5, timestamp), /signature is missing/);
});

test('Paddle event parser rejects malformed envelopes and preserves canonical ids', () => {
  const parsed = parsePaddleEvent(eventBody('evt_parser', '2026-07-17T00:00:00.123456Z'));
  assert.equal(parsed.eventId, 'evt_parser');
  assert.equal(parsed.eventType, 'subscription.updated');
  assert.equal(parsed.occurredAtRaw, '2026-07-17T00:00:00.123456Z');
  assert.equal(parsed.data.id, 'sub_test');
  assert.throws(() => parsePaddleEvent(Buffer.from('{')), /valid JSON/);
  assert.throws(() => parsePaddleEvent(Buffer.from('{}')), /envelope is invalid/);
});

test('ingress commits a durable inbox row before projection and deduplicates provider event ids', async () => {
  const state = createPrismaState();
  const service = new PaddleWebhookService(state.prisma as never, config() as never, {} as never);
  const current = eventBody('evt_current', new Date().toISOString());
  const currentTimestamp = Math.floor(Date.now() / 1000);

  assert.deepEqual(await service.ingest(current, signature(current, currentTimestamp)), {
    accepted: true, duplicate: false, status: 'received',
  });
  assert.equal(state.subscription, null);
  assert.equal(state.event('evt_current')?.attempts, 0);

  const sweep = await service.processDue(25);
  assert.equal(sweep.processed, 1);
  assert.equal(state.subscription?.status, 'active');
  assert.equal(state.event('evt_current')?.status, 'processed');
  assert.equal(state.event('evt_current')?.attempts, 1);

  const duplicate = await service.ingest(current, signature(current, currentTimestamp));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.status, 'processed');
  assert.equal(state.events.size, 1);
});

test('webhook secret rotation accepts the previous secret without weakening deduplication', async () => {
  const previousSecret = 'pdl_ntfset_previous_secret';
  const state = createPrismaState();
  const service = new PaddleWebhookService(state.prisma as never, config('shadow', previousSecret) as never, {} as never);
  const body = eventBody('evt_rotated', new Date().toISOString());
  const timestamp = Math.floor(Date.now() / 1000);
  const result = await service.ingest(body, signatureWith(body, timestamp, previousSecret));
  assert.equal(result.status, 'received');
  assert.equal(state.events.size, 1);
});

test('out-of-order events become stale and equal provider timestamps quarantine instead of guessing by event id', async () => {
  const state = createPrismaState();
  const service = new PaddleWebhookService(state.prisma as never, config() as never, {} as never);
  const now = new Date();
  const timestamp = Math.floor(Date.now() / 1000);
  const current = eventBody('evt_current', now.toISOString(), 'active');
  await service.ingest(current, signature(current, timestamp));
  await service.processDue(25);

  const stale = eventBody('evt_stale', new Date(now.getTime() - 60_000).toISOString(), 'paused');
  await service.ingest(stale, signature(stale, timestamp));
  assert.equal((await service.processDue(25)).stale, 1);
  assert.equal(state.subscription?.status, 'active');

  const tied = eventBody('evt_tied', now.toISOString(), 'canceled');
  await service.ingest(tied, signature(tied, timestamp));
  assert.equal((await service.processDue(25)).quarantined, 1);
  assert.equal(state.event('evt_tied')?.lastError, 'equal_occurred_at_requires_reconciliation');
  assert.equal(state.subscription?.status, 'active');
});

test('microsecond ordering is preserved when JavaScript Date milliseconds are equal', async () => {
  const state = createPrismaState();
  const service = new PaddleWebhookService(state.prisma as never, config() as never, {} as never);
  const timestamp = Math.floor(Date.now() / 1000);
  const earlier = eventBody('evt_micro_a', '2026-07-19T08:00:00.123100Z', 'active');
  const later = eventBody('evt_micro_b', '2026-07-19T08:00:00.123900Z', 'paused');
  await service.ingest(earlier, signature(earlier, timestamp));
  await service.processDue(25);
  await service.ingest(later, signature(later, timestamp));
  await service.processDue(25);
  assert.equal(state.subscription?.status, 'paused');
  assert.equal(state.subscription?.lastEventId, 'evt_micro_b');
});

test('projection failures remain in the local inbox for retry and eventually dead-letter', async () => {
  const state = createPrismaState();
  const projector = { async project() { throw new Error('temporary projector outage'); } };
  const service = new PaddleWebhookService(state.prisma as never, config('live') as never, projector as never);
  const body = eventBody('evt_retry', new Date().toISOString());
  await service.ingest(body, signature(body, Math.floor(Date.now() / 1000)));

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    state.makeDue('evt_retry');
    const result = await service.processDue(25, new Date(Date.now() + attempt * 10_000));
    if (attempt < 8) assert.equal(result.retried, 1);
    else assert.equal(result.deadLettered, 1);
  }
  assert.equal(state.event('evt_retry')?.status, 'dead_letter');
  assert.equal(state.event('evt_retry')?.attempts, 8);
  assert.match(String(state.event('evt_retry')?.lastError), /temporary projector outage/u);
});

test('serializable projection conflicts are retried without duplicating the durable inbox row', async () => {
  const state = createPrismaState({ serializationFailures: 2 });
  const service = new PaddleWebhookService(state.prisma as never, config() as never, {} as never);
  const body = eventBody('evt_serializable', new Date().toISOString());
  await service.ingest(body, signature(body, Math.floor(Date.now() / 1000)));
  const result = await service.processDue(25);
  assert.equal(result.processed, 1);
  assert.equal(state.transactionAttempts, 3);
  assert.equal(state.events.size, 1);
});

function config(mode: 'shadow' | 'live' = 'shadow', previousSecret?: string) {
  const values = { PADDLE_MODE: mode, PADDLE_ENV: 'sandbox', PADDLE_WEBHOOK_SECRET: secret, PADDLE_WEBHOOK_SECRET_PREVIOUS: previousSecret, PADDLE_WEBHOOK_TOLERANCE_SECONDS: 5 };
  return {
    get(key: keyof typeof values, fallback?: unknown) { return values[key] ?? fallback; },
    getOptional(key: keyof typeof values) { return values[key]; },
    getNumber(key: keyof typeof values, fallback?: number) { return Number(values[key] ?? fallback); },
  };
}

function eventBody(eventId: string, occurredAt: string, status = 'active'): Buffer {
  return Buffer.from(JSON.stringify({
    event_id: eventId,
    event_type: 'subscription.updated',
    occurred_at: occurredAt,
    notification_id: `ntf_${eventId}`,
    data: {
      id: 'sub_test', customer_id: 'ctm_test', status,
      next_billed_at: '2026-08-17T00:00:00.000Z',
      current_billing_period: { starts_at: '2026-07-17T00:00:00.000Z', ends_at: '2026-08-17T00:00:00.000Z' },
      scheduled_change: null,
      items: [{ id: 'sbi_test', quantity: 1, price: { id: 'pri_test' } }],
      custom_data: { minewiki_checkout_intent_id: '11111111-1111-4111-8111-111111111111' },
    },
  }));
}

function signature(raw: Buffer, timestamp: number): string {
  return signatureWith(raw, timestamp, secret);
}

function signatureWith(raw: Buffer, timestamp: number, signingSecret: string): string {
  const digest = createHmac('sha256', signingSecret).update(Buffer.concat([Buffer.from(`${timestamp}:`), raw])).digest('hex');
  return `ts=${timestamp};h1=${digest}`;
}

function createPrismaState(options: { serializationFailures?: number } = {}) {
  type EventRow = Record<string, unknown> & { id: bigint; providerEventId: string; status: string; attempts: number };
  type SubscriptionRow = Record<string, unknown> & {
    status: string;
    lastEventId: string;
    lastEventOccurredAt: Date;
    lastEventOccurredAtRaw: string | null;
    billingSubjectId: string | null;
    providerTransactionId: string | null;
  };
  const events = new Map<string, EventRow>();
  let subscription: SubscriptionRow | null = null;
  let nextId = 1n;
  let remainingSerializationFailures = options.serializationFailures ?? 0;
  let transactionAttempts = 0;

  const paddleWebhookEvent = {
    async create({ data }: { data: Record<string, unknown> }) {
      const providerEventId = String(data.providerEventId);
      if (events.has(providerEventId)) {
        throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' });
      }
      const row: EventRow = { id: nextId++, ...data, providerEventId, status: String(data.status), attempts: Number(data.attempts), lockedAt: null, lockedBy: null, lastError: null, processedAt: null, deadLetteredAt: null };
      events.set(providerEventId, row);
      return { id: row.id };
    },
    async findUnique({ where }: { where: Record<string, unknown> }) {
      if (where.id !== undefined) return [...events.values()].find((row) => row.id === where.id) ?? null;
      const unique = where.environment_providerEventId as { providerEventId: string };
      return events.get(unique.providerEventId) ?? null;
    },
    async findMany() {
      return [...events.values()]
        .filter((row) => ['received', 'retry', 'processing'].includes(row.status))
        .sort((left, right) => Number(left.id - right.id))
        .map((row) => ({ id: row.id, attempts: row.attempts }));
    },
    async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      const row = [...events.values()].find((item) => item.id === where.id);
      if (!row) return { count: 0 };
      if (where.lockedBy && row.lockedBy !== where.lockedBy) return { count: 0 };
      if (where.status === 'processing' && row.status !== 'processing') return { count: 0 };
      if (row.status === 'processed' || row.status === 'ignored' || row.status === 'stale' || row.status === 'quarantined' || row.status === 'dead_letter') return { count: 0 };
      const increment = (data.attempts as { increment?: number } | undefined)?.increment ?? 0;
      Object.assign(row, data, { attempts: row.attempts + increment });
      return { count: 1 };
    },
    async update({ where, data }: { where: { id: bigint }; data: Record<string, unknown> }) {
      const row = [...events.values()].find((item) => item.id === where.id);
      if (!row) throw new Error('missing event');
      Object.assign(row, data);
      return row;
    },
  };
  const transaction = {
    paddleWebhookEvent,
    paddleSubscriptionShadow: {
      async findUnique() { return subscription; },
      async upsert({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) {
        const next = subscription ? { ...subscription, ...update } : create;
        subscription = {
          ...next,
          status: String(next.status),
          lastEventId: String(next.lastEventId),
          lastEventOccurredAt: next.lastEventOccurredAt as Date,
          lastEventOccurredAtRaw: typeof next.lastEventOccurredAtRaw === 'string' ? next.lastEventOccurredAtRaw : null,
          billingSubjectId: typeof next.billingSubjectId === 'string' ? next.billingSubjectId : null,
          providerTransactionId: typeof next.providerTransactionId === 'string' ? next.providerTransactionId : null,
        };
        return subscription;
      },
    },
  };
  const prisma = {
    paddleWebhookEvent,
    async $transaction(callback: (value: typeof transaction) => unknown) {
      transactionAttempts += 1;
      if (remainingSerializationFailures > 0) {
        remainingSerializationFailures -= 1;
        throw new Prisma.PrismaClientKnownRequestError('serialization conflict', { code: 'P2034', clientVersion: 'test' });
      }
      return callback(transaction);
    },
  };
  return {
    prisma,
    events,
    event(id: string) { return events.get(id); },
    makeDue(id: string) { const row = events.get(id); if (row) row.availableAt = new Date(0); },
    get subscription() { return subscription; },
    get transactionAttempts() { return transactionAttempts; },
  };
}
