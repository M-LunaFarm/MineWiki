import { Controller, Headers, Post, Query, UnauthorizedException } from '@nestjs/common';
import { derivePaddleWebhookInboxServiceToken } from '@minewiki/auth';
import { ConfigService } from '@minewiki/config';
import { timingSafeEqual } from 'node:crypto';
import { PaddleWebhookService } from './paddle-webhook.service';

@Controller('v1/internal/billing/paddle')
export class PaddleWebhookInternalController {
  constructor(private readonly inbox: PaddleWebhookService, private readonly config: ConfigService) {}

  @Post('process-due')
  processDue(
    @Headers('authorization') authorization: string | undefined,
    @Query('limit') limit?: string,
  ) {
    const expected = derivePaddleWebhookInboxServiceToken(this.config.get('APP_ENCRYPTION_KEY'));
    const presented = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    const expectedBytes = Buffer.from(expected);
    const presentedBytes = Buffer.from(presented);
    if (presentedBytes.length !== expectedBytes.length || !timingSafeEqual(presentedBytes, expectedBytes)) {
      throw new UnauthorizedException('Paddle webhook inbox worker token is invalid.');
    }
    return this.inbox.processDue(limit?.trim() ? Number(limit) : undefined);
  }
}
