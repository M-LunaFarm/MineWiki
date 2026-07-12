import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiAdminService, type WikiAdminPageSummary, type WikiAdminRecentChange } from './wiki-admin.service';
import { WikiProfileService } from './wiki-profile.service';

@Controller('v1/admin/wiki')
@UseGuards(SessionGuard)
export class WikiAdminController {
  constructor(
    private readonly wikiAdmin: WikiAdminService,
    private readonly wikiProfiles: WikiProfileService
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
      !session.isElevated &&
      session.permissions?.includes('wiki.admin') !== true &&
      session.groups?.includes('admin') !== true
    ) {
      throw new ForbiddenException('Wiki admin permission is required.');
    }
    return this.wikiProfiles.ensureWikiProfile(session.userId);
  }
}
