import { Body, ConflictException, Controller, Get, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { VoteService } from './vote.service';
import { type SessionPayload } from '../session/session.service';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import { MinecraftService } from '../minecraft/minecraft.service';

@Controller('v1/servers/:serverId/votes')
export class VoteController {
  constructor(
    private readonly voteService: VoteService,
    private readonly minecraft: MinecraftService
  ) {}

  @Post()
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 5, ttl: 60 } })
  async submit(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ) {
    let minecraftUuid: string | undefined;
    let minecraftUsername: string | undefined;
    try {
      const identity = await this.minecraft.getIdentity(session.userId);
      minecraftUuid = identity.uuid;
      minecraftUsername = identity.playerName;
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }

    return this.voteService.submitVote(serverId, body, {
      ipAddress: session.requestIp ?? undefined,
      accountId: session.userId,
      minecraftUuid,
      minecraftUsername
    });
  }

  @Get('eligibility')
  @UseGuards(SessionGuard)
  async eligibility(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @CurrentSession() session: SessionPayload,
  ) {
    try {
      const identity = await this.minecraft.getIdentity(session.userId);
      return this.voteService.getEligibility(serverId, {
        accountId: session.userId,
        ipAddress: session.requestIp ?? undefined,
        minecraftUuid: identity.uuid,
        minecraftUsername: identity.playerName,
      });
    } catch (error) {
      if (error instanceof NotFoundException) {
        return this.voteService.getEligibility(serverId, {
          accountId: session.userId,
          ipAddress: session.requestIp ?? undefined,
        });
      }
      if (error instanceof ConflictException) {
        return this.voteService.getEligibility(serverId, {
          accountId: session.userId,
          ipAddress: session.requestIp ?? undefined,
          minecraftIdentityConflict: true,
        });
      }
      throw error;
    }
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
