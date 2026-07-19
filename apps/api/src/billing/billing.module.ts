import { Module } from '@nestjs/common';
import { ClaimModule } from '../claim/claim.module';
import { SessionModule } from '../session/session.module';
import { BillingCatalog } from './billing-catalog';
import { PaddleBillingController } from './paddle-billing.controller';
import { PaddleCheckoutService } from './paddle-checkout.service';
import { PaddleClient } from './paddle-client';
import { PaddleEntitlementProjectorService } from './paddle-entitlement-projector.service';
import { PaddlePortalService } from './paddle-portal.service';
import { PaddleWebhookController } from './paddle-webhook.controller';
import { PaddleWebhookService } from './paddle-webhook.service';
import { PaddleWebhookInternalController } from './paddle-webhook-internal.controller';

@Module({
  imports: [ClaimModule, SessionModule],
  controllers: [PaddleWebhookController, PaddleBillingController, PaddleWebhookInternalController],
  providers: [BillingCatalog, PaddleEntitlementProjectorService, PaddleWebhookService, PaddleClient, PaddleCheckoutService, PaddlePortalService],
})
export class BillingModule {}
