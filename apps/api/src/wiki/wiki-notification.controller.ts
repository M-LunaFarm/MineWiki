import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiNotificationService } from './wiki-notification.service';

@Controller('v1/wiki/notifications')
@UseGuards(SessionGuard)
export class WikiNotificationController {
  constructor(private readonly notifications: WikiNotificationService) {}

  @Get()
  list(
    @CurrentSession() session: SessionPayload,
    @Query('cursor') cursor?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number
  ) {
    return this.notifications.list(session, cursor, limit ?? 30);
  }

  @Post('read-all')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  markAllRead(@CurrentSession() session: SessionPayload, @Body() body: { throughId?: string }) {
    return this.notifications.markAllRead(session, body.throughId ?? '');
  }

  @Post(':notificationId/read')
  @Throttle({ default: { limit: 60, ttl: 60 } })
  markRead(@Param('notificationId') notificationId: string, @CurrentSession() session: SessionPayload) {
    return this.notifications.markRead(session, notificationId);
  }
}
