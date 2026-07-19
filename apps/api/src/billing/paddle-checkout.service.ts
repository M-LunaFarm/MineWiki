import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { BillingCatalog, type PaddleBillableLayoutKey } from './billing-catalog';
import { PaddleClient } from './paddle-client';
import { BILLING_POLICY_VERSION } from '@minewiki/schemas/billing-contract';
import { assertActiveBillingOwner } from './billing-server-authority';

const INTENT_LIFETIME_MS = 30 * 60 * 1000;

@Injectable()
export class PaddleCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly catalog: BillingCatalog,
    private readonly paddle: PaddleClient,
  ) {}

  async create(
    serverId: string,
    layoutKey: PaddleBillableLayoutKey,
    accountId: string,
    policyVersion: string,
  ) {
    if (this.config.get('PADDLE_MODE', 'off') !== 'live') {
      throw new ServiceUnavailableException('Online checkout is not enabled.');
    }
    if (policyVersion !== BILLING_POLICY_VERSION) {
      throw new ConflictException({
        statusCode: 409,
        code: 'BILLING_POLICY_STALE',
        message: 'The billing policy changed. Review and accept the current version.',
        currentPolicyVersion: BILLING_POLICY_VERSION,
      });
    }
    const priceId = this.catalog.getProviderPriceId(layoutKey);
    const product = this.catalog.getProduct(layoutKey);
    const intentId = randomUUID();
    const termsAcceptedAt = new Date();
    const environment = this.config.get('PADDLE_ENV', 'sandbox');
    const intent = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM \`Server\` WHERE id = ${serverId} FOR UPDATE
      `;
      await assertActiveBillingOwner(tx, serverId, accountId);
      await tx.$queryRaw<Array<{ id: bigint }>>`
        SELECT id FROM server_wikis WHERE vote_server_id = ${serverId} FOR UPDATE
      `;
      const serverWiki = await tx.serverWiki.findUnique({
        where: { voteServerId: serverId },
        select: { id: true },
      });
      if (!serverWiki) throw new NotFoundException('Server wiki not found.');
      const subject = await tx.paddleBillingSubject.upsert({
        where: { serverWikiId: serverWiki.id },
        create: {
          id: randomUUID(),
          serverWikiId: serverWiki.id,
          createdByAccountId: accountId,
        },
        update: {},
        select: { id: true },
      });
      const openLeaseKey = `${environment}:${subject.id}`;
      const active = await tx.paddleSubscriptionShadow.findFirst({
        where: {
          billingSubjectId: subject.id,
          status: { in: ['active', 'trialing', 'past_due'] },
        },
        select: { id: true },
      });
      if (active) throw new ConflictException('This server wiki already has an active Paddle subscription.');
      return tx.paddleCheckoutIntent.upsert({
        where: { openLeaseKey },
        update: {},
        create: {
          id: intentId,
          billingSubjectId: subject.id,
          environment,
          layoutKey,
          configuredPriceId: priceId,
          policyVersion: BILLING_POLICY_VERSION,
          termsAcceptedAt,
          productSnapshot: product,
          status: 'creating',
          openLeaseKey,
          expiresAt: new Date(Date.now() + INTENT_LIFETIME_MS),
        },
        select: {
          id: true,
          layoutKey: true,
          status: true,
          openLeaseKey: true,
          providerTransactionId: true,
          providerCheckoutUrl: true,
          expiresAt: true,
          createdAt: true,
        },
      });
    });

    if (intent.id !== intentId) {
      if (
        intent.layoutKey === layoutKey
        && intent.status === 'pending'
        && intent.providerTransactionId
        && intent.providerCheckoutUrl
      ) {
        return {
          checkoutUrl: intent.providerCheckoutUrl,
          transactionId: intent.providerTransactionId,
        };
      }
      if (
        intent.status === 'creating'
        && intent.openLeaseKey
        && intent.expiresAt.getTime() <= Date.now()
      ) {
        const recovered = await this.paddle.findTransactionByCheckoutIntent(
          intent.id,
          intent.createdAt,
        );
        if (recovered) {
          await this.attachTransaction(intent.id, intent.openLeaseKey, recovered);
          return {
            checkoutUrl: recovered.checkoutUrl,
            transactionId: recovered.transactionId,
          };
        }
        const released = await this.prisma.paddleCheckoutIntent.updateMany({
          where: {
            id: intent.id,
            status: 'creating',
            openLeaseKey: intent.openLeaseKey,
            expiresAt: { lte: new Date() },
          },
          data: { status: 'expired', openLeaseKey: null },
        });
        if (released.count === 1) {
          return this.create(serverId, layoutKey, accountId, policyVersion);
        }
      }
      throw new ConflictException({
        statusCode: 409,
        code: 'PADDLE_CHECKOUT_IN_PROGRESS',
        message: 'A Paddle checkout is already open for this server wiki.',
      });
    }

    const transaction = await this.paddle.createTransaction({
      priceId,
      checkoutIntentId: intentId,
      checkoutUrl: this.config.get('PADDLE_CHECKOUT_URL'),
    });
    if (!intent.openLeaseKey) {
      throw new ConflictException('The Paddle checkout lease is no longer active.');
    }
    await this.attachTransaction(intentId, intent.openLeaseKey, transaction);
    return {
      checkoutUrl: transaction.checkoutUrl,
      transactionId: transaction.transactionId,
    };
  }

  private async attachTransaction(
    intentId: string,
    openLeaseKey: string,
    transaction: { readonly transactionId: string; readonly checkoutUrl: string },
  ): Promise<void> {
    const attached = await this.prisma.paddleCheckoutIntent.updateMany({
      where: { id: intentId, status: 'creating', openLeaseKey },
      data: {
        status: 'pending',
        providerTransactionId: transaction.transactionId,
        providerCheckoutUrl: transaction.checkoutUrl,
      },
    });
    if (attached.count !== 1) {
      throw new ConflictException('The Paddle checkout lease changed while the transaction was being created.');
    }
  }
}
