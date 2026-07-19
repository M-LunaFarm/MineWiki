import test from 'node:test';
import assert from 'node:assert/strict';
import { PaddleEntitlementProjectorService, type PaddleSubscriptionSnapshot } from './paddle-entitlement-projector.service';

const OCCURRED_AT = new Date('2026-07-17T12:00:00.000Z');
const INTENT_ID = '11111111-1111-4111-8111-111111111111';

test('a valid unused checkout intent binds once and projects an active entitlement', async () => {
  const fixture = createFixture();
  const result = await fixture.projector.project(
    fixture.tx as never,
    'sandbox',
    'evt_created',
    OCCURRED_AT,
    snapshot(),
    null,
  );

  assert.equal(result.status, 'projected');
  assert.equal(result.billingSubjectId, 'subject-1');
  assert.equal(fixture.intentStatus, 'attached');
  assert.equal(fixture.intentOpenLeaseKey, null);
  assert.equal(fixture.entitlements.length, 1);
  assert.deepEqual(fixture.entitlements[0], {
    id: 1n,
    serverWikiId: 9n,
    layoutKey: 'handbook',
    status: 'active',
    source: 'paddle',
    externalReference: 'paddle:sandbox:subscription:sub_test',
    startsAt: new Date('2026-07-17T00:00:00.000Z'),
    expiresAt: null,
    createdBy: null,
    createdAt: OCCURRED_AT,
    updatedAt: OCCURRED_AT,
  });
  assert.equal(fixture.audits[0]?.action, 'billing.paddle.entitlement.projected');
});

test('unknown, mixed, and invalid-quantity items are quarantined without touching persistence', async () => {
  for (const candidate of [
    snapshot({ items: [{ priceId: 'pri_unknown', quantity: 1 }] }),
    snapshot({ items: [{ priceId: 'pri_handbook', quantity: 1 }, { priceId: 'pri_brand', quantity: 1 }] }),
    snapshot({ items: [{ priceId: 'pri_handbook', quantity: 2 }] }),
  ]) {
    const fixture = createFixture();
    const result = await fixture.projector.project(fixture.tx as never, 'sandbox', 'evt_bad', OCCURRED_AT, candidate, null);
    assert.equal(result.status, 'quarantined');
    assert.equal(fixture.intentStatus, 'pending');
    assert.equal(fixture.entitlements.length, 0);
  }
});

test('new bindings require the provider transaction and do not consume an intent on subject conflict', async () => {
  const missingTransaction = createFixture();
  const missing = await missingTransaction.projector.project(
    missingTransaction.tx as never,
    'sandbox',
    'evt_missing_txn',
    OCCURRED_AT,
    snapshot({ transactionId: null }),
    null,
  );
  assert.equal(missing.error, 'checkout_transaction_missing');
  assert.equal(missingTransaction.intentStatus, 'pending');

  const conflict = createFixture({ activeSubscriptionConflict: true });
  const conflicted = await conflict.projector.project(
    conflict.tx as never,
    'sandbox',
    'evt_conflict',
    OCCURRED_AT,
    snapshot(),
    null,
  );
  assert.equal(conflicted.error, 'subject_has_active_subscription');
  assert.equal(conflict.intentStatus, 'pending');
});

test('an already-bound subscription ignores hostile custom data and never rebinds', async () => {
  const fixture = createFixture({ intentSubjectId: 'subject-2' });
  const result = await fixture.projector.project(
    fixture.tx as never,
    'sandbox',
    'evt_hostile',
    OCCURRED_AT,
    snapshot(),
    { billingSubjectId: 'subject-1' },
  );
  assert.equal(result.billingSubjectId, 'subject-1');
  assert.equal(result.status, 'projected');
  assert.equal(fixture.intentStatus, 'pending');
  assert.equal(fixture.entitlements.length, 1);
});

test('a malformed newest snapshot revokes only the existing Paddle entitlement', async () => {
  const fixture = createFixture({
    selectedLayout: 'handbook',
    manualCoverage: true,
    entitlements: [entitlement()],
  });
  const result = await fixture.projector.project(
    fixture.tx as never,
    'sandbox',
    'evt_malformed',
    OCCURRED_AT,
    snapshot({ items: [] }),
    { billingSubjectId: 'subject-1' },
  );
  assert.equal(result.status, 'quarantined');
  assert.equal(fixture.entitlements[0]?.status, 'revoked');
  assert.equal(fixture.serverLayout, 'handbook');
  assert.equal(fixture.audits[0]?.action, 'billing.paddle.entitlement.quarantined_revocation');
});

test('canceling Paddle revokes only its entitlement while a manual entitlement preserves the selected layout', async () => {
  const fixture = createFixture({
    selectedLayout: 'handbook',
    manualCoverage: true,
    entitlements: [entitlement()],
  });
  const result = await fixture.projector.project(
    fixture.tx as never,
    'sandbox',
    'evt_canceled',
    OCCURRED_AT,
    snapshot({ status: 'canceled', checkoutIntentId: null }),
    { billingSubjectId: 'subject-1' },
  );
  assert.equal(result.status, 'projected');
  assert.equal(fixture.entitlements[0]?.status, 'revoked');
  assert.equal(fixture.serverLayout, 'handbook');
  assert.equal(fixture.audits[0]?.action, 'billing.paddle.entitlement.revoked');
});

test('past-due subscriptions receive a bounded grace expiry and payment recovery clears it', async () => {
  const fixture = createFixture();
  await fixture.projector.project(
    fixture.tx as never,
    'sandbox',
    'evt_past_due',
    OCCURRED_AT,
    snapshot({
      status: 'past_due',
      periodEndsAt: new Date('2026-07-16T00:00:00.000Z'),
    }),
    null,
  );
  assert.deepEqual(fixture.entitlements[0]?.expiresAt, new Date('2026-07-24T12:00:00.000Z'));

  await fixture.projector.project(
    fixture.tx as never,
    'sandbox',
    'evt_recovered',
    new Date('2026-07-18T12:00:00.000Z'),
    snapshot({ status: 'active', checkoutIntentId: null }),
    { billingSubjectId: 'subject-1' },
  );
  assert.equal(fixture.entitlements[0]?.expiresAt, null);
});

function snapshot(overrides: Partial<PaddleSubscriptionSnapshot> = {}): PaddleSubscriptionSnapshot {
  return {
    subscriptionId: 'sub_test',
    customerId: 'ctm_test',
    transactionId: 'txn_test',
    status: 'active',
    nextBilledAt: new Date('2026-08-17T00:00:00.000Z'),
    periodStartsAt: new Date('2026-07-17T00:00:00.000Z'),
    periodEndsAt: new Date('2026-08-17T00:00:00.000Z'),
    checkoutIntentId: INTENT_ID,
    items: [{ priceId: 'pri_handbook', quantity: 1 }],
    ...overrides,
  };
}

function entitlement() {
  return {
    id: 1n,
    serverWikiId: 9n,
    layoutKey: 'handbook',
    status: 'active',
    source: 'paddle',
    externalReference: 'paddle:sandbox:subscription:sub_test',
    startsAt: new Date('2026-07-17T00:00:00.000Z'),
    expiresAt: new Date('2026-08-17T00:00:00.000Z'),
    createdBy: null,
    createdAt: OCCURRED_AT,
    updatedAt: OCCURRED_AT,
  };
}

function createFixture(options: {
  readonly intentSubjectId?: string;
  readonly selectedLayout?: string;
  readonly manualCoverage?: boolean;
  readonly activeSubscriptionConflict?: boolean;
  readonly entitlements?: ReturnType<typeof entitlement>[];
} = {}) {
  let intentStatus = 'pending';
  let intentOpenLeaseKey: string | null = 'sandbox:subject-1';
  let serverLayout = options.selectedLayout ?? 'docs';
  const entitlements = [...(options.entitlements ?? [])];
  const audits: Array<{ action: string }> = [];
  const subject = {
    id: options.intentSubjectId ?? 'subject-1',
    serverWikiId: 9n,
    serverWiki: { layoutKey: serverLayout },
  };
  const tx = {
    paddleCheckoutIntent: {
      async findUnique() {
        return {
          id: INTENT_ID,
          billingSubjectId: subject.id,
          environment: 'sandbox',
          layoutKey: 'handbook',
          configuredPriceId: 'pri_handbook',
          status: intentStatus,
          providerTransactionId: 'txn_test',
          createdAt: new Date('2026-07-17T11:00:00.000Z'),
          expiresAt: new Date('2026-07-17T13:00:00.000Z'),
          billingSubject: subject,
        };
      },
      async updateMany({ data }: { data: { status: string; openLeaseKey: string | null } }) {
        intentStatus = data.status;
        intentOpenLeaseKey = data.openLeaseKey;
        return { count: 1 };
      },
    },
    paddleBillingSubject: {
      async findUnique() {
        return { id: 'subject-1', serverWikiId: 9n, serverWiki: { layoutKey: serverLayout } };
      },
    },
    paddleSubscriptionShadow: {
      async findFirst() { return options.activeSubscriptionConflict ? { id: 77n } : null; },
    },
    serverWikiLayoutEntitlement: {
      async findUnique({ where }: { where: { externalReference: string } }) {
        return entitlements.find((row) => row.externalReference === where.externalReference) ?? null;
      },
      async findFirst() { return options.manualCoverage ? { id: 99n } : null; },
      async create({ data }: { data: Omit<ReturnType<typeof entitlement>, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> }) {
        const row = { id: 1n, ...data, createdBy: null, createdAt: OCCURRED_AT, updatedAt: OCCURRED_AT };
        entitlements.push(row);
        return row;
      },
      async update({ where, data }: { where: { id: bigint }; data: Partial<ReturnType<typeof entitlement>> }) {
        const row = entitlements.find((candidate) => candidate.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    serverWiki: {
      async update({ data }: { data: { layoutKey: string } }) { serverLayout = data.layoutKey; return {}; },
    },
    auditEvent: {
      async create({ data }: { data: { action: string } }) { audits.push({ action: data.action }); return data; },
    },
  };
  const catalog = {
    findLayoutByProviderPriceId(priceId: string) {
      return priceId === 'pri_handbook' ? 'handbook' : priceId === 'pri_brand' ? 'brand' : null;
    },
  };
  return {
    tx,
    projector: new PaddleEntitlementProjectorService(catalog as never),
    entitlements,
    audits,
    get intentStatus() { return intentStatus; },
    get intentOpenLeaseKey() { return intentOpenLeaseKey; },
    get serverLayout() { return serverLayout; },
  };
}
