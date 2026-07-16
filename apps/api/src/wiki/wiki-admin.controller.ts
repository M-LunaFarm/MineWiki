import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import {
  WikiAdminService,
  type WikiAdminPageSummary,
  type WikiAdminRecentChange,
  type WikiAdminRevisionDetail,
  type WikiAdminRevisionPage,
  type WikiRevisionEditSummaryModerationResult
} from './wiki-admin.service';
import { WikiModerationService } from './wiki-moderation.service';
import { WikiProfileService } from './wiki-profile.service';

@Controller('v1/admin/wiki')
@RequireStepUp('wiki_admin')
@UseGuards(SessionGuard)
export class WikiAdminController {
  constructor(
    private readonly wikiAdmin: WikiAdminService,
    private readonly wikiProfiles: WikiProfileService,
    private readonly wikiModeration: WikiModerationService
  ) {}

  @Get('recent')
  async getRecent(@CurrentSession() session: SessionPayload): Promise<WikiAdminRecentChange[]> {
    await this.assertAdmin(session);
    return this.wikiAdmin.getRecent();
  }

  @Get('pages')
  async getPages(
    @Query('status') status: string | undefined,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiAdminPageSummary[]> {
    await this.assertAdmin(session);
    return this.wikiAdmin.getPages(status);
  }

  @Get('pages/:id/revisions')
  async getPageRevisions(
    @Param('id') pageId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiAdminRevisionPage> {
    await this.assertAdmin(session);
    return this.wikiAdmin.getPageRevisions(pageId, cursor, limit);
  }

  @Get('revisions/:id')
  async getRevision(
    @Param('id') revisionId: string,
    @CurrentSession() session: SessionPayload
  ): Promise<WikiAdminRevisionDetail> {
    await this.assertAdmin(session);
    return this.wikiAdmin.getRevision(revisionId);
  }

  @Get('users')
  async getUsers(@Query('q') query: string | undefined, @CurrentSession() session: SessionPayload) {
    await this.assertBlockAdmin(session);
    return this.wikiAdmin.getUsers(query);
  }

  @Get('user-block-events')
  async getUserBlockEvents(
    @Query('targetProfileId') targetProfileId: string | undefined,
    @CurrentSession() session: SessionPayload
  ) {
    await this.assertBlockAdmin(session);
    return this.wikiAdmin.getUserBlockEvents(targetProfileId);
  }

  @Post('users/:id/block')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  async blockUser(
    @Param('id') targetProfileId: string,
    @Body() body: { reason?: string; publicReason?: string },
    @CurrentSession() session: SessionPayload
  ) {
    const actor = await this.assertBlockAdmin(session);
    return this.wikiAdmin.setUserBlocked({ targetProfileId, actorProfileId: actor.id, blocked: true, reason: body.reason, publicReason: body.publicReason });
  }

  @Post('users/:id/unblock')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  async unblockUser(
    @Param('id') targetProfileId: string,
    @Body() body: { reason?: string; publicReason?: string },
    @CurrentSession() session: SessionPayload
  ) {
    const actor = await this.assertBlockAdmin(session);
    return this.wikiAdmin.setUserBlocked({ targetProfileId, actorProfileId: actor.id, blocked: false, reason: body.reason, publicReason: body.publicReason });
  }

  @Get('acl')
  async getAclRules(@CurrentSession() session: SessionPayload) {
    await this.assertAdmin(session);
    return this.wikiAdmin.getAclRules();
  }

  @Get('acl/catalog')
  async getAclCatalog(@CurrentSession() session: SessionPayload) {
    await this.assertAdmin(session);
    return this.wikiAdmin.getAclCatalog();
  }

  @Post('acl')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  async createAclRule(
    @Body() body: {
      targetType?: string;
      targetId?: string | null;
      action?: string;
      effect?: string;
      subjectType?: string;
      subjectValue?: string;
      reason?: string | null;
      expiresAt?: string | null;
    },
    @CurrentSession() session: SessionPayload
  ) {
    const actor = await this.assertAdmin(session);
    return this.wikiAdmin.createAclRule({ ...body, actorProfileId: actor.id });
  }

  @Delete('acl/:id')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  async deleteAclRule(
    @Param('id') ruleId: string,
    @Body() body: { reason?: string | null },
    @CurrentSession() session: SessionPayload
  ) {
    const actor = await this.assertAdmin(session);
    return this.wikiAdmin.deleteAclRule({
      ruleId,
      actorProfileId: actor.id,
      reason: body.reason
    });
  }

  @Post('batch-rollback/preview')
  @Throttle({ default: { limit: 10, ttl: 60 } })
  async previewBatchRollback(
    @Body() body: { targetProfileId?: string; sinceMinutes?: number | string; limit?: number | string },
    @CurrentSession() session: SessionPayload
  ) {
    await this.assertBatchRollbackAdmin(session);
    return this.wikiModeration.preview(body);
  }

  @Post('batch-rollback/execute')
  @Throttle({ default: { limit: 2, ttl: 60 } })
  async executeBatchRollback(
    @Body() body: {
      targetProfileId?: string;
      sinceMinutes?: number | string;
      reason?: string;
      confirmUsername?: string;
      candidates?: Array<{ pageId?: string; expectedCurrentRevisionId?: string }>;
    },
    @CurrentSession() session: SessionPayload
  ) {
    const actor = await this.assertBatchRollbackAdmin(session);
    return this.wikiModeration.execute({ ...body, actorProfileId: actor.id });
  }

  @Patch('pages/:id/protection')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  async updateProtection(
    @Param('id') pageId: string,
    @Body() body: { protectionLevel?: string; reason?: string },
    @CurrentSession() session: SessionPayload
  ): Promise<WikiAdminPageSummary> {
    const actor = await this.assertAdmin(session);
    return this.wikiAdmin.updateProtection({
      pageId,
      protectionLevel: body.protectionLevel,
      actorProfileId: actor.id,
      reason: body.reason
    });
  }

  @Patch('revisions/:id/visibility')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  async updateRevisionVisibility(
    @Param('id') revisionId: string,
    @Body() body: { visibility?: string; reason?: string },
    @CurrentSession() session: SessionPayload
  ): Promise<{ revisionId: string; visibility: string }> {
    const actor = await this.assertAdmin(session);
    return this.wikiAdmin.updateRevisionVisibility({
      revisionId,
      visibility: body.visibility,
      actorProfileId: actor.id,
      reason: body.reason
    });
  }

  @Patch('revisions/:id/edit-summary')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  async setRevisionEditSummaryHidden(
    @Param('id') revisionId: string,
    @Body() body: { hidden?: boolean; expectedVersion?: number | string; reason?: string },
    @CurrentSession() session: SessionPayload
  ): Promise<WikiRevisionEditSummaryModerationResult> {
    const actor = await this.assertRevisionSummaryModerator(session);
    return this.wikiAdmin.setRevisionEditSummaryHidden({
      revisionId,
      hidden: body.hidden,
      expectedVersion: body.expectedVersion,
      actorProfileId: actor.id,
      reason: body.reason
    });
  }

  @Post('pages/:id/rollback')
  @Throttle({ default: { limit: 6, ttl: 60 } })
  async rollback(
    @Param('id') pageId: string,
    @Body() body: { revisionId?: string; reason?: string },
    @CurrentSession() session: SessionPayload
  ): Promise<{ pageId: string; revisionId: string; revisionNo: number }> {
    const actor = await this.assertAdmin(session);
    return this.wikiAdmin.rollback({
      pageId,
      revisionId: body.revisionId,
      actorProfileId: actor.id,
      reason: body.reason
    });
  }

  @Post('pages/:id/delete')
  @Throttle({ default: { limit: 6, ttl: 60 } })
  async deletePage(
    @Param('id') pageId: string,
    @Body() body: { reason?: string },
    @CurrentSession() session: SessionPayload
  ): Promise<WikiAdminPageSummary> {
    const actor = await this.assertAdmin(session);
    return this.wikiAdmin.setPageStatus({
      pageId,
      status: 'deleted',
      actorProfileId: actor.id,
      reason: body.reason
    });
  }

  @Post('pages/:id/restore')
  @Throttle({ default: { limit: 6, ttl: 60 } })
  async restorePage(
    @Param('id') pageId: string,
    @Body() body: { reason?: string },
    @CurrentSession() session: SessionPayload
  ): Promise<WikiAdminPageSummary> {
    const actor = await this.assertAdmin(session);
    return this.wikiAdmin.setPageStatus({
      pageId,
      status: 'normal',
      actorProfileId: actor.id,
      reason: body.reason
    });
  }

  private async assertAdmin(session: SessionPayload): Promise<{ id: bigint }> {
    if (
      session.permissions?.includes('wiki.admin') !== true &&
      session.groups?.some((group) => group === 'owner' || group === 'admin') !== true
    ) {
      throw new ForbiddenException('Wiki admin permission is required.');
    }
    return this.wikiProfiles.ensureWikiProfile(session.userId);
  }

  private async assertBlockAdmin(session: SessionPayload): Promise<{ id: bigint }> {
    if (
      session.permissions?.includes('wiki.user.block') !== true &&
      session.groups?.some((group) => group === 'owner' || group === 'admin') !== true
    ) {
      throw new ForbiddenException('Wiki user block permission is required.');
    }
    return this.wikiProfiles.ensureWikiProfile(session.userId);
  }

  private async assertBatchRollbackAdmin(session: SessionPayload): Promise<{ id: bigint }> {
    if (
      session.permissions?.includes('wiki.batch_rollback') !== true &&
      session.groups?.some((group) => group === 'owner' || group === 'admin') !== true
    ) {
      throw new ForbiddenException('Wiki batch rollback permission is required.');
    }
    return this.wikiProfiles.ensureWikiProfile(session.userId);
  }

  private async assertRevisionSummaryModerator(session: SessionPayload): Promise<{ id: bigint }> {
    if (
      session.permissions?.includes('wiki.admin') !== true
      && session.groups?.some((group) => group === 'owner' || group === 'admin') !== true
    ) {
      throw new ForbiddenException('Wiki revision moderation permission is required.');
    }
    return this.wikiProfiles.ensureWikiProfile(session.userId);
  }
}
