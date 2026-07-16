import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import {
  WikiApiTokenService,
  type WikiApiSpaceView,
  type WikiApiTokenCreated,
  type WikiApiTokenView,
} from './wiki-api-token.service';

@Controller('v1/wiki/api-tokens')
@UseGuards(SessionGuard)
export class WikiApiTokenController {
  constructor(private readonly tokens: WikiApiTokenService) {}

  @Get()
  list(@CurrentSession() session: SessionPayload): Promise<WikiApiTokenView[]> {
    return this.tokens.list(session.userId);
  }

  @Get('spaces')
  listSpaces(@CurrentSession() session: SessionPayload): Promise<WikiApiSpaceView[]> {
    return this.tokens.listSpaces(session);
  }

  @Post()
  @Throttle({ default: { limit: 5, ttl: 60 } })
  create(
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ): Promise<WikiApiTokenCreated> {
    return this.tokens.create(session, body);
  }

  @Delete(':id')
  @Throttle({ default: { limit: 10, ttl: 60 } })
  revoke(
    @Param('id') tokenId: string,
    @CurrentSession() session: SessionPayload,
  ): Promise<{ readonly revoked: true }> {
    return this.tokens.revoke(session, tokenId);
  }
}
