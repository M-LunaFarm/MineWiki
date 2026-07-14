import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiAclGroupService } from './wiki-acl-group.service';
import { WikiProfileService } from './wiki-profile.service';

@Controller('v1/admin/wiki/acl-groups')
@UseGuards(SessionGuard)
export class WikiAclGroupAdminController {
  constructor(
    private readonly groups: WikiAclGroupService,
    private readonly profiles: WikiProfileService
  ) {}

  @Get()
  async list(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('status') status: string | undefined,
    @CurrentSession() session: SessionPayload
  ) {
    await this.assertAdmin(session);
    return this.groups.listGroups({ cursor, limit, status });
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60 } })
  async create(
    @Body() body: { key?: string; title?: string; description?: string | null; selfRemovable?: boolean },
    @CurrentSession() session: SessionPayload
  ) {
    const actor = await this.assertAdmin(session);
    return this.groups.createGroup({ ...body, actorProfileId: actor.id });
  }

  @Patch(':groupId')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  async update(
    @Param('groupId') groupId: string,
    @Body() body: { title?: string; description?: string | null; status?: string; selfRemovable?: boolean; reason?: string | null },
    @CurrentSession() session: SessionPayload
  ) {
    const actor = await this.assertAdmin(session);
    return this.groups.updateGroup({ groupId, ...body, actorProfileId: actor.id });
  }

  @Delete(':groupId')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  async remove(
    @Param('groupId') groupId: string,
    @Body() body: { reason?: string | null },
    @CurrentSession() session: SessionPayload
  ) {
    const actor = await this.assertAdmin(session);
    return this.groups.deleteGroup({ groupId, reason: body.reason, actorProfileId: actor.id });
  }

  @Get(':groupId/members')
  async listMembers(
    @Param('groupId') groupId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('includeRemoved') includeRemoved: string | undefined,
    @CurrentSession() session: SessionPayload
  ) {
    await this.assertAdmin(session);
    return this.groups.listMembers({ groupId, cursor, limit, includeRemoved: includeRemoved === 'true' });
  }

  @Post(':groupId/members')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  async addMember(
    @Param('groupId') groupId: string,
    @Body() body: { memberType?: string; userId?: string | null; address?: string | null; expiresAt?: string | null; reason?: string | null },
    @CurrentSession() session: SessionPayload
  ) {
    const actor = await this.assertAdmin(session);
    return this.groups.addMember({ groupId, ...body, actorProfileId: actor.id });
  }

  @Patch(':groupId/members/:memberId/expiry')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  async updateMemberExpiry(
    @Param('groupId') groupId: string,
    @Param('memberId') memberId: string,
    @Body() body: { expiresAt?: string | null; reason?: string | null },
    @CurrentSession() session: SessionPayload
  ) {
    const actor = await this.assertAdmin(session);
    return this.groups.updateMemberExpiry({ groupId, memberId, ...body, actorProfileId: actor.id });
  }

  @Delete(':groupId/members/:memberId')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  async removeMember(
    @Param('groupId') groupId: string,
    @Param('memberId') memberId: string,
    @Body() body: { reason?: string | null },
    @CurrentSession() session: SessionPayload
  ) {
    const actor = await this.assertAdmin(session);
    return this.groups.removeMember({ groupId, memberId, reason: body.reason, actorProfileId: actor.id });
  }

  private async assertAdmin(session: SessionPayload): Promise<{ id: bigint }> {
    if (
      !session.isElevated &&
      session.permissions?.includes('wiki.admin') !== true &&
      session.permissions?.includes('wiki.acl.manage') !== true &&
      session.groups?.some((group) => group === 'owner' || group === 'admin') !== true
    ) {
      throw new ForbiddenException('Wiki ACL group administration permission is required.');
    }
    return this.profiles.ensureWikiProfile(session.userId);
  }
}

@Controller('v1/wiki/acl-groups')
@UseGuards(SessionGuard)
export class WikiAclGroupSelfController {
  constructor(
    private readonly groups: WikiAclGroupService,
    private readonly profiles: WikiProfileService
  ) {}

  @Post(':groupId/self-remove')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async selfRemove(
    @Param('groupId') groupId: string,
    @CurrentSession() session: SessionPayload
  ) {
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    return this.groups.selfRemove({
      groupId,
      profileId: profile.id,
      requestIp: session.requestIp
    });
  }
}
