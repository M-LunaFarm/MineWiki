import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiProfileMergeService } from './wiki-profile-merge.service';

@Controller('v1/wiki/profile-merges')
@UseGuards(SessionGuard)
export class WikiProfileMergeController {
  constructor(private readonly merges: WikiProfileMergeService) {}

  @Get('preview')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  preview(@CurrentSession() session: SessionPayload) {
    return this.merges.preview(session.userId);
  }

  @Post()
  @Throttle({ default: { limit: 3, ttl: 300 } })
  request(
    @CurrentSession() session: SessionPayload,
    @Body() body: {
      sourceProfileId?: string;
      sourceUsername?: string;
      targetUsername?: string;
      reason?: string;
    }
  ) {
    return this.merges.request(session.userId, body);
  }
}
