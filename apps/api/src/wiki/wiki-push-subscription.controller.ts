import { Body, Controller, Delete, Get, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiPushSubscriptionService } from './wiki-push-subscription.service';

@Controller('v1/wiki/notifications/push')
@UseGuards(SessionGuard)
export class WikiPushSubscriptionController {
  constructor(private readonly push: WikiPushSubscriptionService) {}

  @Get()
  @Throttle({ default: { limit: 30, ttl: 60 } })
  status(@CurrentSession() session: SessionPayload) {
    return this.push.status(session);
  }

  @Put('subscription')
  @Throttle({ default: { limit: 8, ttl: 300 } })
  register(@CurrentSession() session: SessionPayload, @Body() body: unknown) {
    return this.push.register(session, body);
  }

  @Delete('subscription')
  @Throttle({ default: { limit: 12, ttl: 300 } })
  unregister(@CurrentSession() session: SessionPayload) {
    return this.push.unregister(session);
  }
}
