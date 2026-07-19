import { Controller, Get, Headers, Param, ParseIntPipe, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ServerWikiDomainService } from './server-wiki-domain.service';

@Controller('v1/internal/wiki-domain-provisioning')
export class ServerWikiDomainProvisioningController {
  constructor(
    private readonly domains: ServerWikiDomainService,
    private readonly config: ConfigService,
  ) {}

  @Post(':hostname/activate')
  async activate(
    @Headers('authorization') authorization: string | undefined,
    @Param('hostname') hostname: string,
    @Query('expectedVersion', new ParseIntPipe()) expectedVersion: number,
  ) {
    this.assertProvisioner(authorization);
    return { domain: await this.domains.activateProvisioned(hostname, expectedVersion) };
  }

  @Post('revalidate')
  revalidate(
    @Headers('authorization') authorization: string | undefined,
    @Query('limit') limit?: string,
  ) {
    this.assertProvisioner(authorization);
    return this.domains.revalidateDue(limit?.trim() ? Number(limit) : undefined);
  }

  @Get('domains')
  list(
    @Headers('authorization') authorization: string | undefined,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    this.assertProvisioner(authorization);
    return this.domains.listProvisioningDomains(cursor, limit?.trim() ? Number(limit) : undefined);
  }

  private assertProvisioner(authorization: string | undefined): void {
    const expected = deriveServerWikiDomainProvisionerToken(this.config.get('APP_ENCRYPTION_KEY'));
    const presented = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    const expectedBytes = Buffer.from(expected);
    const presentedBytes = Buffer.from(presented);
    if (presentedBytes.length !== expectedBytes.length || !timingSafeEqual(presentedBytes, expectedBytes)) {
      throw new UnauthorizedException('Server wiki domain provisioner token is invalid.');
    }
  }
}

export function deriveServerWikiDomainProvisionerToken(appEncryptionKey: string): string {
  return createHmac('sha256', appEncryptionKey)
    .update('minewiki:server-wiki-domain-provisioner:v1')
    .digest('base64url');
}
