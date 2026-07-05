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
import { z } from 'zod';
import {
  discordVerifyCompleteRequestSchema,
  discordVerifySessionCreateRequestSchema,
  type DiscordVerifySessionResponse
} from '@minewiki/schemas';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { VerifyService } from './verify.service';

const discordVerifyCompleteBodySchema = discordVerifyCompleteRequestSchema.extend({
  sessionId: z.string().uuid()
});

const discordVerifyRevokeBodySchema = z.object({
  guildId: z.string().trim().min(1),
  discordUserId: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(120).optional()
});

@Controller('v1/discord/verify')
export class DiscordVerifyController {
  constructor(private readonly verifyService: VerifyService) {}

  @Post('sessions')
  createSession(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown
  ): Promise<DiscordVerifySessionResponse> {
    this.verifyService.assertInternalBotToken(authorization);
    return this.verifyService.createDiscordSession(
      discordVerifySessionCreateRequestSchema.parse(body)
    );
  }

  @Get('sessions/:sessionId')
  getSession(
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string
  ): Promise<DiscordVerifySessionResponse> {
    return this.verifyService.getDiscordSession(sessionId);
  }

  @UseGuards(SessionGuard)
  @Post('complete')
  completeSession(
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown
  ): Promise<DiscordVerifySessionResponse> {
    const payload = discordVerifyCompleteBodySchema.parse(body);
    return this.verifyService.completeDiscordSession(payload.sessionId, session.userId, payload);
  }

  @Post('revoke')
  revoke(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown
  ): Promise<{ guildId: string; discordUserId: string; status: 'revoked' }> {
    this.verifyService.assertInternalBotToken(authorization);
    const payload = discordVerifyRevokeBodySchema.parse(body) as {
      guildId: string;
      discordUserId: string;
      reason?: string;
    };
    return this.verifyService.revokeDiscordVerification(payload);
  }
}
