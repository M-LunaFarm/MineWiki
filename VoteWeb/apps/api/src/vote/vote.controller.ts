import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { VoteService } from './vote.service';
import { SessionService } from '../session/session.service';
import { MinecraftService } from '../minecraft/minecraft.service';
import { extractClientIp } from '../common/http/client-ip';

@Controller('v1/servers/:serverId/votes')
export class VoteController {
  constructor(
    private readonly voteService: VoteService,
    private readonly sessions: SessionService,
    private readonly minecraft: MinecraftService
  ) {}

  @Post()
  @Throttle({ default: { limit: 5, ttl: 60 } })
  async submit(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest
  ) {
    const ipAddress = extractClientIp(request);
    const sessionToken = extractSessionToken(request);
    const session = sessionToken
      ? await this.sessions.getSessionByToken(sessionToken)
      : undefined;
    let minecraftUuid: string | undefined;
    if (session) {
      try {
        const identity = await this.minecraft.getIdentity(session.userId);
        minecraftUuid = identity.uuid;
      } catch {
        minecraftUuid = undefined;
      }
    }

    return this.voteService.submitVote(serverId, body, {
      ipAddress,
      accountId: session?.userId,
      minecraftUuid
    });
  }

  @Get('recent')
  async recent(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('search') search?: string
  ) {
    return this.voteService.listRecentVotes(serverId, {
      limit,
      search: search?.trim() ? search.trim() : undefined
    });
  }
}

function extractSessionToken(request: FastifyRequest): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(';')) {
    const [key, value] = part.trim().split('=');
    if (key === 'cv_session') {
      return decodeURIComponent(value ?? '');
    }
  }
  return undefined;
}
