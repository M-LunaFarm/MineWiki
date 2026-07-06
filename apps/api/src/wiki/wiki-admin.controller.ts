import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
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

  @Patch('pages/:id/protection')
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
    if (!session.isElevated) {
      throw new ForbiddenException('Wiki admin permission is required.');
    }
    return this.wikiProfiles.ensureWikiProfile(session.userId);
  }
}
