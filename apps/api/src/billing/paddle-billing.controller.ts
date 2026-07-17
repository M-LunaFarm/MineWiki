import { Body, Controller, ForbiddenException, Get, Header, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ClaimService } from '../claim/claim.service';
import { CurrentSession } from '../session/session.decorator';
import { RequireStepUp } from '../session/step-up.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { PaddleCheckoutService } from './paddle-checkout.service';
import { PaddlePortalService } from './paddle-portal.service';

const checkoutSchema = z.object({ layoutKey: z.enum(['handbook', 'brand']) }).strict();

@Controller('v1/servers/:serverId/billing')
@UseGuards(SessionGuard)
export class PaddleBillingController {
  constructor(
    private readonly claims: ClaimService,
    private readonly config: ConfigService,
    private readonly checkout: PaddleCheckoutService,
    private readonly portal: PaddlePortalService,
  ) {}

  @Post('checkout')
  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async createCheckout(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    await this.assertOwner(serverId, session);
    return this.checkout.create(serverId, checkoutSchema.parse(body).layoutKey, session.userId);
  }

  @Post('portal')
  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 10, ttl: 300 } })
  @Header('Cache-Control', 'no-store')
  async createPortal(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @CurrentSession() session: SessionPayload,
  ) {
    await this.assertOwner(serverId, session);
    return this.portal.create(serverId);
  }

  @Get('availability')
  @Header('Cache-Control', 'no-store')
  async availability(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @CurrentSession() session: SessionPayload,
  ) {
    await this.assertOwner(serverId, session);
    return {
      onlineCheckout: this.config.get('PADDLE_MODE', 'off') === 'live',
      environment: this.config.get('PADDLE_ENV', 'sandbox'),
    };
  }

  private async assertOwner(serverId: string, session: SessionPayload): Promise<void> {
    if (session.permissions?.includes('server.admin') === true) return;
    if (!(await this.claims.isOwner(serverId, session.userId))) {
      throw new ForbiddenException('Server owner access is required for billing.');
    }
  }
}
