import { Module } from '@nestjs/common';
import { PaddleWebhookController } from './paddle-webhook.controller';
import { PaddleWebhookService } from './paddle-webhook.service';

@Module({
  controllers: [PaddleWebhookController],
  providers: [PaddleWebhookService],
})
export class BillingModule {}
