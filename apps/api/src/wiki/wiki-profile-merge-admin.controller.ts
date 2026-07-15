import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import { WikiProfileMergeService } from './wiki-profile-merge.service';
import { WikiProfileService } from './wiki-profile.service';

@Controller('v1/admin/wiki/profile-merges')
@RequireStepUp('wiki_admin')
@UseGuards(SessionGuard)
export class WikiProfileMergeAdminController {
  constructor(
    private readonly merges: WikiProfileMergeService,
    private readonly profiles: WikiProfileService
  ) {}

  @Get()
  async list(
    @Query('status') status: string | undefined,
    @CurrentSession() session: SessionPayload
  ) {
    await this.assertAdmin(session);
    return this.merges.listForAdmin(status);
  }

  @Post(':requestId/approve')
  @Throttle({ default: { limit: 4, ttl: 300 } })
  async approve(
    @Param('requestId') requestId: string,
    @Body() body: { sourceUsername?: string; targetUsername?: string; reason?: string },
    @CurrentSession() session: SessionPayload
  ) {
    const actor = await this.assertAdmin(session);
    return this.merges.approve(
      requestId,
      { accountId: session.userId, profileId: actor.id },
      body
    );
  }

  @Post(':requestId/reject')
  @Throttle({ default: { limit: 8, ttl: 300 } })
  async reject(
    @Param('requestId') requestId: string,
    @Body() body: { reason?: string },
    @CurrentSession() session: SessionPayload
  ) {
    const actor = await this.assertAdmin(session);
    return this.merges.reject(
      requestId,
      { accountId: session.userId, profileId: actor.id },
      body.reason
    );
  }

  private async assertAdmin(session: SessionPayload): Promise<{ id: bigint }> {
    if (
      session.permissions?.includes('wiki.admin') !== true &&
      session.groups?.some((group) => group === 'owner' || group === 'admin') !== true
    ) {
      throw new ForbiddenException('Wiki admin permission is required.');
    }
    return this.profiles.ensureWikiProfile(session.userId);
  }
}
