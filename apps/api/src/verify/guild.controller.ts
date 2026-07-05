import { Body, Controller, Get, Headers, Param, Patch } from '@nestjs/common';
import { z } from 'zod';
import {
  type LunaGuildDetailResponse,
  type LunaGuildResponse,
  type LunaGuildSettingsRequest,
  VerifyService
} from './verify.service';

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
  constructor(private readonly verifyService: VerifyService) {}

  @Get()
  list(@Headers('authorization') authorization: string | undefined): Promise<LunaGuildResponse[]> {
    this.verifyService.assertInternalBotToken(authorization);
    return this.verifyService.listGuilds();
  }

  @Get(':guildId')
  get(
    @Headers('authorization') authorization: string | undefined,
    @Param('guildId') guildId: string
  ): Promise<LunaGuildDetailResponse> {
    this.verifyService.assertInternalBotToken(authorization);
    return this.verifyService.getGuild(guildId);
  }

  @Patch(':guildId/settings')
  updateSettings(
    @Headers('authorization') authorization: string | undefined,
    @Param('guildId') guildId: string,
    @Body() body: unknown
  ) {
    this.verifyService.assertInternalBotToken(authorization);
    const payload = guildSettingsSchema.parse(body) as LunaGuildSettingsRequest;
    return this.verifyService.updateGuildSettings(guildId, payload);
  }
}
