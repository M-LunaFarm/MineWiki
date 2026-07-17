import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { BillingCatalog, type PaddleBillableLayoutKey } from './billing-catalog';
import { PaddleClient } from './paddle-client';

const INTENT_LIFETIME_MS = 30 * 60 * 1000;

@Injectable()
export class PaddleCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly catalog: BillingCatalog,
    private readonly paddle: PaddleClient,
  ) {}

  async create(serverId: string, layoutKey: PaddleBillableLayoutKey, accountId: string) {
    if (this.config.get('PADDLE_MODE', 'off') !== 'live') {
      throw new ServiceUnavailableException('Online checkout is not enabled.');
    }
    const priceId = this.catalog.getProviderPriceId(layoutKey);
    const serverWiki = await this.prisma.serverWiki.findUnique({
      where: { voteServerId: serverId },
      select: { id: true },
    });
    if (!serverWiki) throw new NotFoundException('Server wiki not found.');

    const subject = await this.prisma.paddleBillingSubject.upsert({
      where: { serverWikiId: serverWiki.id },
      create: {
        id: randomUUID(),
        serverWikiId: serverWiki.id,
        createdByAccountId: accountId,
      },
      update: {},
      select: { id: true },
    });
    const active = await this.prisma.paddleSubscriptionShadow.findFirst({
      where: {
        billingSubjectId: subject.id,
        status: { in: ['active', 'trialing', 'past_due'] },
      },
      select: { id: true },
    });
    if (active) throw new ConflictException('This server wiki already has an active Paddle subscription.');

    const intentId = randomUUID();
    await this.prisma.paddleCheckoutIntent.create({
      data: {
        id: intentId,
        billingSubjectId: subject.id,
        environment: this.config.get('PADDLE_ENV', 'sandbox'),
        layoutKey,
        configuredPriceId: priceId,
        status: 'pending',
        expiresAt: new Date(Date.now() + INTENT_LIFETIME_MS),
      },
    });

    const transaction = await this.paddle.createTransaction({
      priceId,
      checkoutIntentId: intentId,
      checkoutUrl: this.config.get('PADDLE_CHECKOUT_URL'),
    });
    await this.prisma.paddleCheckoutIntent.update({
      where: { id: intentId },
      data: { providerTransactionId: transaction.transactionId },
    });
    return { checkoutUrl: transaction.checkoutUrl };
  }
}
