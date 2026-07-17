import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { PrismaService } from '../common/prisma.service';
import { PaddleClient } from './paddle-client';

@Injectable()
export class PaddlePortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly paddle: PaddleClient,
  ) {}

  async create(serverId: string) {
    if (this.config.get('PADDLE_MODE', 'off') !== 'live') {
      throw new ServiceUnavailableException('Paddle customer portal is not enabled.');
    }
    const subject = await this.prisma.paddleBillingSubject.findFirst({
      where: { serverWiki: { voteServerId: serverId } },
      select: { id: true },
    });
    if (!subject) throw new NotFoundException('No billing account exists for this server wiki.');
    const subscription = await this.prisma.paddleSubscriptionShadow.findFirst({
      where: { billingSubjectId: subject.id },
      orderBy: { lastEventOccurredAt: 'desc' },
      select: { providerCustomerId: true, providerSubscriptionId: true },
    });
    if (!subscription?.providerCustomerId) {
      throw new NotFoundException('No manageable Paddle subscription exists.');
    }
    const portal = await this.paddle.createPortalSession(
      subscription.providerCustomerId,
      subscription.providerSubscriptionId,
    );
    return { portalUrl: portal.overviewUrl };
  }
}
