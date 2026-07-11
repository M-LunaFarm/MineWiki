import {
  Body,
  BadRequestException,
  Controller,
  ForbiddenException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import {
  ServerService,
  type VerificationRecheckOptions,
  type VerificationRecheckResult,
} from './server.service';
import { ClaimService } from '../claim/claim.service';
import { SessionGuard } from '../session/session.guard';
import { CurrentSession } from '../session/session.decorator';
import type { SessionPayload } from '../session/session.service';

const recheckSchema = z.object({
  passed: z.boolean(),
  checkedAt: z.string().datetime().optional(),
  reason: z.string().min(3).max(160).optional(),
});

@Controller('v1/servers/:serverId/verification')
export class ServerVerificationController {
  constructor(
    private readonly serverService: ServerService,
    private readonly claimService: ClaimService,
  ) {}

  @UseGuards(SessionGuard)
  @Post('recheck')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async recheck(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ): Promise<VerificationRecheckResult> {
    if (!(await this.claimService.isOwner(serverId, session.userId))) {
      throw new ForbiddenException('해당 서버의 검증 상태를 변경할 권한이 없습니다.');
    }
    const parsed = recheckSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('검증 재점검 요청 형식을 확인해주세요.');
    }
    const payload = parsed.data as VerificationRecheckOptions;
    return this.serverService.recheckVerification(serverId, payload);
  }
}
