import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { BusinessEventService } from '../events/business-event.service';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import {
  RoleService,
  type AccountAccess,
  type AccountRoleSummary,
  type RoleSummary,
} from './role.service';

const PROTECTED_ROLE_CODES = new Set(['owner', 'admin']);

@Controller('v1/admin/roles')
@UseGuards(SessionGuard)
export class RoleAdminController {
  constructor(
    private readonly roles: RoleService,
    private readonly events: BusinessEventService,
  ) {}

  @Get()
  async listRoles(@CurrentSession() session: SessionPayload): Promise<RoleSummary[]> {
    this.assertRoleAdmin(session);
    return this.roles.listRoles();
  }

  @Get('accounts')
  async searchAccounts(
    @Query('q') query: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentSession() session: SessionPayload,
  ): Promise<AccountRoleSummary[]> {
    this.assertRoleAdmin(session);
    return this.roles.searchAccounts(query, limit);
  }

  @Post('accounts/:accountId')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  async assignRole(
    @Param('accountId') accountId: string,
    @Body() body: { roleCode?: string },
    @CurrentSession() session: SessionPayload,
  ): Promise<AccountAccess> {
    const roleCode = this.assertRoleMutation(session, body.roleCode);
    const access = await this.roles.assignRole(accountId, roleCode);
    await this.events.audit('admin.role.assigned', {
      category: 'admin',
      actorAccountId: session.userId,
      subjectType: 'account',
      subjectId: accountId,
      metadata: { roleCode },
    });
    return access;
  }

  @Delete('accounts/:accountId/:roleCode')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  async removeRole(
    @Param('accountId') accountId: string,
    @Param('roleCode') roleCodeInput: string,
    @CurrentSession() session: SessionPayload,
  ): Promise<AccountAccess> {
    const roleCode = this.assertRoleMutation(session, roleCodeInput);
    const access = await this.roles.removeRole(accountId, roleCode);
    await this.events.audit('admin.role.removed', {
      category: 'admin',
      actorAccountId: session.userId,
      subjectType: 'account',
      subjectId: accountId,
      metadata: { roleCode },
    });
    return access;
  }

  private assertRoleAdmin(session: SessionPayload): void {
    if (
      session.groups?.includes('owner') !== true &&
      session.groups?.includes('admin') !== true
    ) {
      throw new ForbiddenException('Role administration permission is required.');
    }
  }

  private assertRoleMutation(session: SessionPayload, roleCodeInput?: string): string {
    this.assertRoleAdmin(session);
    const roleCode = roleCodeInput?.trim();
    if (!roleCode) {
      throw new BadRequestException('A role code is required.');
    }
    if (
      PROTECTED_ROLE_CODES.has(roleCode) &&
      session.groups?.includes('owner') !== true
    ) {
      throw new ForbiddenException('Only an owner can manage owner or admin roles.');
    }
    return roleCode;
  }
}
