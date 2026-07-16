import { Controller, Headers, Post, Query, UnauthorizedException } from '@nestjs/common';
import { deriveBillingLifecycleServiceToken } from '@minewiki/auth';
import { ConfigService } from '@minewiki/config';
import { timingSafeEqual } from 'node:crypto';
import { ServerWikiLayoutEntitlementLifecycleService } from './server-wiki-layout-entitlement-lifecycle.service';

@Controller('v1/internal/billing')
export class ServerWikiLayoutEntitlementInternalController {
  constructor(
    private readonly lifecycle: ServerWikiLayoutEntitlementLifecycleService,
    private readonly config: ConfigService,
  ) {}

  @Post('reconcile-entitlements')
  processDue(
    @Headers('authorization') authorization: string | undefined,
    @Query('limit') limit?: string,
  ) {
    const expected = deriveBillingLifecycleServiceToken(this.config.get('APP_ENCRYPTION_KEY'));
    const presented = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    const expectedBytes = Buffer.from(expected);
    const presentedBytes = Buffer.from(presented);
    if (presentedBytes.length !== expectedBytes.length || !timingSafeEqual(presentedBytes, expectedBytes)) {
      throw new UnauthorizedException('Billing lifecycle worker token is invalid.');
    }
    return this.lifecycle.processDue(limit?.trim() ? Number(limit) : undefined);
  }
}
