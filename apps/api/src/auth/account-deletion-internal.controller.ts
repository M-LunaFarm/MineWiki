import { Controller, Headers, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { deriveAccountDeletionServiceToken } from '@minewiki/auth';
import { timingSafeEqual } from 'node:crypto';
import { AccountDeletionService } from './account-deletion.service';

@Controller('v1/internal/account-deletions')
export class AccountDeletionInternalController {
  constructor(private readonly deletions: AccountDeletionService, private readonly config: ConfigService) {}

  @Post('process-due')
  processDue(@Headers('authorization') authorization: string | undefined, @Query('limit') limit?: string) {
    const expected = deriveAccountDeletionServiceToken(this.config.get('APP_ENCRYPTION_KEY'));
    const presented = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    const expectedBytes = Buffer.from(expected);
    const presentedBytes = Buffer.from(presented);
    if (presentedBytes.length !== expectedBytes.length || !timingSafeEqual(presentedBytes, expectedBytes)) {
      throw new UnauthorizedException('Account deletion worker token is invalid.');
    }
    return this.deletions.processDue('internal:account-deletion-worker', Number(limit));
  }
}
