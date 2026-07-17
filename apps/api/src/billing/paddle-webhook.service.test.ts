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
  const parsed = parsePaddleEvent(eventBody('evt_parser', '2026-07-17T00:00:00.000Z'));
  assert.equal(parsed.eventId, 'evt_parser');
  assert.equal(parsed.eventType, 'subscription.updated');
  assert.equal(parsed.data.id, 'sub_test');
  assert.throws(() => parsePaddleEvent(Buffer.from('{')), /valid JSON/);
  assert.throws(() => parsePaddleEvent(Buffer.from('{}')), /envelope is invalid/);
});

test('shadow inbox deduplicates event ids and refuses out-of-order subscription rollback', async () => {
  const state = createPrismaState();
  const service = new PaddleWebhookService(state.prisma as never, config() as never);
  const current = eventBody('evt_current', new Date().toISOString());
  const currentTimestamp = Math.floor(Date.now() / 1000);

  assert.deepEqual(await service.ingest(current, signature(current, currentTimestamp)), {
    accepted: true,
    duplicate: false,
    status: 'processed',
  });
  assert.equal(state.subscription?.status, 'active');

  const duplicate = await service.ingest(current, signature(current, currentTimestamp));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.status, 'processed');

  const stale = eventBody('evt_stale', new Date(Date.now() - 60_000).toISOString(), 'paused');
  assert.deepEqual(await service.ingest(stale, signature(stale, currentTimestamp)), {
    accepted: true,
    duplicate: false,
    status: 'stale',
  });
  assert.equal(state.subscription?.status, 'active');
});

function config() {
  const values = {
    PADDLE_MODE: 'shadow',
    PADDLE_ENV: 'sandbox',
    PADDLE_WEBHOOK_SECRET: secret,
    PADDLE_WEBHOOK_TOLERANCE_SECONDS: 5,
  };
  return {
    get(key: keyof typeof values, fallback?: unknown) { return values[key] ?? fallback; },
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
      id: 'sub_test',
      customer_id: 'ctm_test',
      status,
      next_billed_at: '2026-08-17T00:00:00.000Z',
      current_billing_period: {
        starts_at: '2026-07-17T00:00:00.000Z',
        ends_at: '2026-08-17T00:00:00.000Z',
      },
      scheduled_change: null,
      items: [{ id: 'sbi_test', quantity: 1, price: { id: 'pri_test' } }],
      custom_data: { checkout_id: 'redacted-value' },
    },
  }));
}

function signature(raw: Buffer, timestamp: number): string {
  const digest = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}:`), raw]))
    .digest('hex');
  return `ts=${timestamp};h1=${digest}`;
}

function createPrismaState() {
  const events = new Map<string, { id: bigint; status: string }>();
  let subscription: { status: string; lastEventOccurredAt: Date } | null = null;
  let nextId = 1n;
  const transaction = {
    paddleWebhookEvent: {
      async create({ data }: { data: { providerEventId: string } }) {
        if (events.has(data.providerEventId)) {
          throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' });
        }
        const row = { id: nextId++, status: 'received' };
        events.set(data.providerEventId, row);
        return { id: row.id };
      },
      async update({ where, data }: { where: { id: bigint }; data: { status: string } }) {
        const row = [...events.values()].find((item) => item.id === where.id);
        if (row) row.status = data.status;
        return row;
      },
    },
    paddleSubscriptionShadow: {
      async findUnique() { return subscription ? { lastEventOccurredAt: subscription.lastEventOccurredAt } : null; },
      async upsert({ update }: { update: { status: string; lastEventOccurredAt: Date } }) {
        subscription = { status: update.status, lastEventOccurredAt: update.lastEventOccurredAt };
        return subscription;
      },
    },
  };
  const prisma = {
    async $transaction(callback: (value: typeof transaction) => unknown) { return callback(transaction); },
    paddleWebhookEvent: {
      async findUnique({ where }: { where: { environment_providerEventId: { providerEventId: string } } }) {
        const row = events.get(where.environment_providerEventId.providerEventId);
        return row ? { status: row.status } : null;
      },
    },
  };
  return { prisma, get subscription() { return subscription; } };
}
