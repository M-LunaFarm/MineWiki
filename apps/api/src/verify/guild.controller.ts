import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Req,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type LunaGuildDetailResponse,
  type LunaGuildResponse,
  type LunaGuildSettingsRequest,
  VerifyService
} from './verify.service';
import { GuildAccessService } from './guild-access.service';
import { CurrentSession } from '../session/session.decorator';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';

const guildSettingsSchema = z.object({
  channelId: z.string().trim().min(1).optional(),
  verifiedRoleId: z.string().trim().min(1).nullable().optional(),
  logChannelId: z.string().trim().min(1).nullable().optional(),
  nicknameFormat: z.string().trim().min(1).max(128).nullable().optional(),
  botMessageTemplate: z.string().trim().min(1).max(512).nullable().optional(),
  botMessagePayload: z.unknown().optional(),
  verifyReplyPayload: z.unknown().optional(),
  policyJson: z.unknown().optional()
});

@Controller('v1/guilds')
export class GuildController {
  constructor(
    private readonly verifyService: VerifyService,
    private readonly guildAccess: GuildAccessService
  ) {}

  @UseGuards(OptionalSessionGuard)
  @Get()
  list(
    @Headers('authorization') authorization: string | undefined,
    @Req() request: FastifyRequest
  ): Promise<LunaGuildResponse[]> {
    if (this.verifyService.isInternalBotToken(authorization)) {
      return this.verifyService.listGuilds();
    }
    return this.guildAccess.listAccessibleGuilds(requireSession(request));
  }

  @UseGuards(SessionGuard)
  @Get('me')
  listMine(@CurrentSession() session: SessionPayload): Promise<LunaGuildResponse[]> {
    return this.guildAccess.listAccessibleGuilds(session);
  }

  @UseGuards(OptionalSessionGuard)
  @Get(':guildId')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Param('guildId') guildId: string,
    @Req() request: FastifyRequest
  ): Promise<LunaGuildDetailResponse> {
    if (!this.verifyService.isInternalBotToken(authorization)) {
      await this.guildAccess.assertCanViewGuild(requireSession(request), guildId);
    }
    return this.verifyService.getGuild(guildId);
  }

  @UseGuards(OptionalSessionGuard)
  @Patch(':guildId/settings')
  async updateSettings(
    @Headers('authorization') authorization: string | undefined,
    @Param('guildId') guildId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest
  ) {
    if (!this.verifyService.isInternalBotToken(authorization)) {
      await this.guildAccess.assertCanManageGuild(requireSession(request), guildId);
    }
    const payload = guildSettingsSchema.parse(body) as LunaGuildSettingsRequest;
    return this.verifyService.updateGuildSettings(guildId, payload);
  }
}

function requireSession(request: FastifyRequest): SessionPayload {
  if (!request.sessionPayload) {
    throw new UnauthorizedException('Login is required.');
  }
  return request.sessionPayload;
}
