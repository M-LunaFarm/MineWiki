import { Injectable } from '@nestjs/common';
import { Prisma, type ServerWikiLayoutEntitlement } from '@prisma/client';
import { BillingCatalog, type PaddleBillableLayoutKey } from './billing-catalog';
import { toAuditJson } from '../events/business-event.service';

const ACCESS_STATUSES = new Set(['active', 'trialing', 'past_due']);
const REVOKED_STATUSES = new Set(['paused', 'canceled']);

export interface PaddleSubscriptionSnapshot {
  readonly subscriptionId: string;
  readonly customerId: string | null;
  readonly transactionId: string | null;
  readonly status: string;
  readonly nextBilledAt: Date | null;
  readonly periodStartsAt: Date | null;
  readonly periodEndsAt: Date | null;
  readonly checkoutIntentId: string | null;
  readonly items: readonly { readonly priceId: string | null; readonly quantity: number | null }[];
}

export interface ExistingPaddleBinding {
  readonly billingSubjectId: string | null;
}

export interface PaddleProjectionResult {
  readonly billingSubjectId: string | null;
  readonly status: 'projected' | 'quarantined';
  readonly error: string | null;
  readonly projectedAt: Date | null;
}

interface SubjectContext {
  readonly id: string;
  readonly serverWikiId: bigint;
  readonly selectedLayout: string;
  readonly checkoutIntentId: string | null;
}

@Injectable()
export class PaddleEntitlementProjectorService {
  constructor(private readonly catalog: BillingCatalog) {}

  async project(
    tx: Prisma.TransactionClient,
    environment: string,
    eventId: string,
    occurredAt: Date,
    snapshot: PaddleSubscriptionSnapshot,
    existing: ExistingPaddleBinding | null,
  ): Promise<PaddleProjectionResult> {
    const item = snapshot.items.length === 1 ? snapshot.items[0] : null;
    if (!item) return this.quarantineInvalidSnapshot(tx, environment, eventId, occurredAt, snapshot, existing, 'unsupported_item_count');
    if (item.quantity !== 1) return this.quarantineInvalidSnapshot(tx, environment, eventId, occurredAt, snapshot, existing, 'unsupported_item_quantity');
    if (!item.priceId) return this.quarantineInvalidSnapshot(tx, environment, eventId, occurredAt, snapshot, existing, 'missing_price_id');
    const layoutKey = this.catalog.findLayoutByProviderPriceId(item.priceId);
    if (!layoutKey) return this.quarantineInvalidSnapshot(tx, environment, eventId, occurredAt, snapshot, existing, 'unknown_price_id');
    if (!ACCESS_STATUSES.has(snapshot.status) && !REVOKED_STATUSES.has(snapshot.status)) {
      return this.quarantineInvalidSnapshot(tx, environment, eventId, occurredAt, snapshot, existing, 'unsupported_subscription_status');
    }

    const subject = existing?.billingSubjectId
      ? await this.resolveExistingSubject(tx, existing.billingSubjectId)
      : await this.bindNewSubject(tx, environment, occurredAt, snapshot, item.priceId, layoutKey);
    if (typeof subject === 'string') return quarantine(existing, subject);

    const conflicting = await tx.paddleSubscriptionShadow.findFirst({
      where: {
        billingSubjectId: subject.id,
        providerSubscriptionId: { not: snapshot.subscriptionId },
        status: { in: [...ACCESS_STATUSES] },
        projectionStatus: 'projected',
      },
      select: { id: true },
    });
    if (conflicting) return quarantine(existing, 'subject_has_active_subscription');
    if (subject.checkoutIntentId) {
      const attached = await tx.paddleCheckoutIntent.updateMany({
        where: { id: subject.checkoutIntentId, status: 'pending' },
        data: { status: 'attached' },
      });
      if (attached.count !== 1) return quarantine(existing, 'checkout_intent_already_used');
    }

    if (ACCESS_STATUSES.has(snapshot.status)) {
      await this.grantOrUpdate(tx, environment, eventId, occurredAt, snapshot, subject, layoutKey);
    } else {
      await this.revoke(tx, environment, eventId, occurredAt, snapshot, subject);
    }
    return {
      billingSubjectId: subject.id,
      status: 'projected',
      error: null,
      projectedAt: new Date(),
    };
  }

  private async resolveExistingSubject(
    tx: Prisma.TransactionClient,
    subjectId: string,
  ): Promise<SubjectContext | string> {
    const subject = await tx.paddleBillingSubject.findUnique({
      where: { id: subjectId },
      select: { id: true, serverWikiId: true, serverWiki: { select: { layoutKey: true } } },
    });
    if (!subject) return 'bound_subject_missing';
    return {
      id: subject.id,
      serverWikiId: subject.serverWikiId,
      selectedLayout: subject.serverWiki.layoutKey,
      checkoutIntentId: null,
    };
  }

  private async bindNewSubject(
    tx: Prisma.TransactionClient,
    environment: string,
    occurredAt: Date,
    snapshot: PaddleSubscriptionSnapshot,
    priceId: string,
    layoutKey: PaddleBillableLayoutKey,
  ): Promise<SubjectContext | string> {
    if (!snapshot.checkoutIntentId || !UUID_PATTERN.test(snapshot.checkoutIntentId)) {
      return 'checkout_intent_missing';
    }
    const intent = await tx.paddleCheckoutIntent.findUnique({
      where: { id: snapshot.checkoutIntentId },
      include: { billingSubject: { include: { serverWiki: { select: { layoutKey: true } } } } },
    });
    if (!intent) return 'checkout_intent_missing';
    if (intent.status !== 'pending') return 'checkout_intent_already_used';
    if (intent.environment !== environment) return 'checkout_environment_mismatch';
    if (intent.createdAt > occurredAt || intent.expiresAt < occurredAt) return 'checkout_intent_expired';
    if (intent.configuredPriceId !== priceId || intent.layoutKey !== layoutKey) return 'checkout_catalog_mismatch';
    if (!intent.providerTransactionId || !snapshot.transactionId) return 'checkout_transaction_missing';
    if (intent.providerTransactionId !== snapshot.transactionId) return 'checkout_transaction_mismatch';
    return {
      id: intent.billingSubject.id,
      serverWikiId: intent.billingSubject.serverWikiId,
      selectedLayout: intent.billingSubject.serverWiki.layoutKey,
      checkoutIntentId: intent.id,
    };
  }

  private async grantOrUpdate(
    tx: Prisma.TransactionClient,
    environment: string,
    eventId: string,
    occurredAt: Date,
    snapshot: PaddleSubscriptionSnapshot,
    subject: SubjectContext,
    layoutKey: PaddleBillableLayoutKey,
  ): Promise<void> {
    const externalReference = entitlementReference(environment, snapshot.subscriptionId);
    const current = await tx.serverWikiLayoutEntitlement.findUnique({ where: { externalReference } });
    if (current && (current.serverWikiId !== subject.serverWikiId || current.source !== 'paddle')) {
      throw new Error('Paddle entitlement subject conflict.');
    }
    const startsAt = snapshot.periodStartsAt && snapshot.periodStartsAt <= occurredAt
      ? snapshot.periodStartsAt
      : occurredAt;
    const entitlement = current
      ? await tx.serverWikiLayoutEntitlement.update({
          where: { id: current.id },
          data: { layoutKey, status: 'active', source: 'paddle', startsAt, expiresAt: null },
        })
      : await tx.serverWikiLayoutEntitlement.create({
          data: { serverWikiId: subject.serverWikiId, layoutKey, status: 'active', source: 'paddle', externalReference, startsAt, expiresAt: null },
        });
    if (current && current.layoutKey !== layoutKey) {
      await downgradeIfUncovered(tx, subject.serverWikiId, subject.selectedLayout, occurredAt);
    }
    await appendAudit(tx, 'billing.paddle.entitlement.projected', entitlement, eventId, snapshot.status);
  }

  private async revoke(
    tx: Prisma.TransactionClient,
    environment: string,
    eventId: string,
    occurredAt: Date,
    snapshot: PaddleSubscriptionSnapshot,
    subject: SubjectContext,
  ): Promise<void> {
    const current = await tx.serverWikiLayoutEntitlement.findUnique({
      where: { externalReference: entitlementReference(environment, snapshot.subscriptionId) },
    });
    if (!current) return;
    if (current.serverWikiId !== subject.serverWikiId || current.source !== 'paddle') {
      throw new Error('Paddle entitlement subject conflict.');
    }
    const updated = await tx.serverWikiLayoutEntitlement.update({
      where: { id: current.id },
      data: { status: 'revoked', expiresAt: occurredAt },
    });
    await downgradeIfUncovered(tx, subject.serverWikiId, subject.selectedLayout, occurredAt);
    await appendAudit(tx, 'billing.paddle.entitlement.revoked', updated, eventId, snapshot.status);
  }

  private async quarantineInvalidSnapshot(
    tx: Prisma.TransactionClient,
    environment: string,
    eventId: string,
    occurredAt: Date,
    snapshot: PaddleSubscriptionSnapshot,
    existing: ExistingPaddleBinding | null,
    error: string,
  ): Promise<PaddleProjectionResult> {
    if (!existing?.billingSubjectId) return quarantine(existing, error);
    const subject = await tx.paddleBillingSubject.findUnique({
      where: { id: existing.billingSubjectId },
      select: { id: true, serverWikiId: true, serverWiki: { select: { layoutKey: true } } },
    });
    if (!subject) return quarantine(existing, error);
    const current = await tx.serverWikiLayoutEntitlement.findUnique({
      where: { externalReference: entitlementReference(environment, snapshot.subscriptionId) },
    });
    if (current) {
      if (current.serverWikiId !== subject.serverWikiId || current.source !== 'paddle') {
        throw new Error('Paddle entitlement subject conflict.');
      }
      const revoked = await tx.serverWikiLayoutEntitlement.update({
        where: { id: current.id },
        data: { status: 'revoked', expiresAt: occurredAt },
      });
      await downgradeIfUncovered(tx, subject.serverWikiId, subject.serverWiki.layoutKey, occurredAt);
      await appendAudit(tx, 'billing.paddle.entitlement.quarantined_revocation', revoked, eventId, error);
    }
    return quarantine(existing, error);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function entitlementReference(environment: string, subscriptionId: string): string {
  return `paddle:${environment}:subscription:${subscriptionId}`;
}

function quarantine(existing: ExistingPaddleBinding | null, error: string): PaddleProjectionResult {
  return { billingSubjectId: existing?.billingSubjectId ?? null, status: 'quarantined', error, projectedAt: null };
}

async function downgradeIfUncovered(
  tx: Prisma.TransactionClient,
  serverWikiId: bigint,
  selectedLayout: string,
  now: Date,
): Promise<void> {
  if (selectedLayout === 'docs') return;
  const covered = await tx.serverWikiLayoutEntitlement.findFirst({
    where: {
      serverWikiId,
      layoutKey: selectedLayout,
      status: 'active',
      startsAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true },
  });
  if (!covered) {
    await tx.serverWiki.update({
      where: { id: serverWikiId },
      data: { layoutKey: 'docs', layoutUpdatedAt: now, layoutUpdatedBy: null },
    });
  }
}

async function appendAudit(
  tx: Prisma.TransactionClient,
  action: string,
  entitlement: ServerWikiLayoutEntitlement,
  eventId: string,
  providerStatus: string,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      category: 'billing',
      action,
      severity: action.endsWith('revoked') ? 'warning' : 'info',
      actorAccountId: null,
      subjectType: 'server_wiki_layout_entitlement',
      subjectId: entitlement.id.toString(),
      metadata: toAuditJson({
        systemActor: 'internal:paddle-webhook',
        providerEventId: eventId,
        providerStatus,
        entitlementId: entitlement.id,
        serverWikiId: entitlement.serverWikiId,
        layoutKey: entitlement.layoutKey,
        status: entitlement.status,
        expiresAt: entitlement.expiresAt,
      }),
    },
  });
}
