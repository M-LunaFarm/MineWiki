import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  discordVerifyCompleteRequestSchema,
  discordVerifySessionCreateRequestSchema,
  pluginSyncEventSchema,
  type DiscordVerifySessionResponse
} from '@minewiki/schemas';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { VerifyService } from './verify.service';

@Controller('v1/verify')
export class VerifyController {
  constructor(private readonly verifyService: VerifyService) {}

  @Post('discord/sessions')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  createDiscordSession(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown
  ): Promise<DiscordVerifySessionResponse> {
    this.verifyService.assertInternalBotToken(authorization);
    return this.verifyService.createDiscordSession(
      discordVerifySessionCreateRequestSchema.parse(body)
    );
  }

  @Get('discord/sessions/:sessionId')
  getDiscordSession(
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string
  ): Promise<DiscordVerifySessionResponse> {
    return this.verifyService.getDiscordSession(sessionId);
  }

  @UseGuards(SessionGuard)
  @Post('discord/sessions/:sessionId/complete')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  completeDiscordSession(
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown
  ): Promise<DiscordVerifySessionResponse> {
    return this.verifyService.completeDiscordSession(
      sessionId,
      session.userId,
      discordVerifyCompleteRequestSchema.parse(body)
    );
  }

  @Post('plugin/sync')
  @Throttle({ default: { limit: 30, ttl: 60 } })
  recordPluginSync(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown
  ): Promise<{ id: string; accepted: true }> {
    this.verifyService.assertPluginSyncToken(authorization);
    return this.verifyService.recordPluginSync(pluginSyncEventSchema.parse(body));
  }
}
