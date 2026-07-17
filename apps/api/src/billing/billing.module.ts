import { Module } from '@nestjs/common';
import { ClaimModule } from '../claim/claim.module';
import { SessionModule } from '../session/session.module';
import { BillingCatalog } from './billing-catalog';
import { PaddleBillingController } from './paddle-billing.controller';
import { PaddleCheckoutService } from './paddle-checkout.service';
import { PaddleClient } from './paddle-client';
import { PaddlePortalService } from './paddle-portal.service';
import { PaddleWebhookController } from './paddle-webhook.controller';
import { PaddleWebhookService } from './paddle-webhook.service';

@Module({
  imports: [ClaimModule, SessionModule],
  controllers: [PaddleWebhookController, PaddleBillingController],
  providers: [BillingCatalog, PaddleWebhookService, PaddleClient, PaddleCheckoutService, PaddlePortalService],
})
export class BillingModule {}
