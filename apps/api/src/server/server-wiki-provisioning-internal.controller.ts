import {
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { deriveServerWikiProvisioningServiceToken } from '@minewiki/auth';
import { ConfigService } from '@minewiki/config';
import { timingSafeEqual } from 'node:crypto';
import { ServerService } from './server.service';

@Controller('v1/internal/server-wikis')
export class ServerWikiProvisioningInternalController {
  constructor(
    private readonly servers: ServerService,
    private readonly config: ConfigService,
  ) {}

  @Post(':serverId/provision')
  provision(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Headers('authorization') authorization: string | undefined,
  ) {
    const expected = deriveServerWikiProvisioningServiceToken(
      this.config.get('APP_ENCRYPTION_KEY'),
    );
    const presented = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    const expectedBytes = Buffer.from(expected);
    const presentedBytes = Buffer.from(presented);
    if (
      presentedBytes.length !== expectedBytes.length
      || !timingSafeEqual(presentedBytes, expectedBytes)
    ) {
      throw new UnauthorizedException('Server wiki provisioning worker token is invalid.');
    }
    return this.servers.ensureClaimedServerWiki(serverId);
  }
}
