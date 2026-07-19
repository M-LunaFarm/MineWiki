import { Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ClaimService } from '../claim/claim.service';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import { ServerWikiDomainService } from './server-wiki-domain.service';

const configureSchema = z.object({
  hostname: z.string().trim().min(1).max(253),
  expectedVersion: z.number().int().min(0),
}).strict();
const versionSchema = z.object({ expectedVersion: z.number().int().min(0) }).strict();
const disableSchema = versionSchema.extend({ reason: z.string().trim().min(5).max(500) }).strict();

@Controller('v1/servers/:serverId/wiki-domain')
@UseGuards(SessionGuard)
export class ServerWikiDomainController {
  constructor(
    private readonly domains: ServerWikiDomainService,
    private readonly claims: ClaimService,
  ) {}

  @Get()
  @Throttle({ default: { limit: 30, ttl: 60 } })
  async get(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @CurrentSession() session: SessionPayload,
  ) {
    await this.assertOwner(serverId, session);
    return { domain: await this.domains.get(serverId) };
  }

  @Put()
  @RequireStepUp('server_admin')
  @Throttle({ default: { limit: 6, ttl: 300 } })
  async configure(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    await this.assertOwner(serverId, session);
    const input = configureSchema.parse(body);
    return { domain: await this.domains.configure(serverId, input.hostname, input.expectedVersion, session.userId) };
  }

  @Post('verify')
  @RequireStepUp('server_admin')
  @Throttle({ default: { limit: 6, ttl: 300 } })
  async verify(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    await this.assertOwner(serverId, session);
    const input = versionSchema.parse(body);
    return { domain: await this.domains.verify(serverId, input.expectedVersion, session.userId) };
  }

  @Delete()
  @RequireStepUp('server_admin')
  @Throttle({ default: { limit: 4, ttl: 300 } })
  async disable(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    await this.assertOwner(serverId, session);
    const input = disableSchema.parse(body);
    return { domain: await this.domains.disable(serverId, input.expectedVersion, input.reason, session.userId) };
  }

  private async assertOwner(serverId: string, session: SessionPayload): Promise<void> {
    if (session.permissions?.includes('server.admin') === true) return;
    if (!(await this.claims.isOwner(serverId, session.userId))) {
      // Keep managers and unrelated accounts on one indistinguishable denial path.
      throw new NotFoundException('서버 위키 도메인을 찾을 수 없습니다.');
    }
  }
}

@Controller('v1/wiki/domain-routes')
export class ServerWikiDomainRouteController {
  constructor(private readonly domains: ServerWikiDomainService) {}

  @Get(':hostname')
  @Throttle({ default: { limit: 120, ttl: 60 } })
  route(@Param('hostname') hostname: string) {
    return this.domains.resolveActiveHost(hostname);
  }
}
