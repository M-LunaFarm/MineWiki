import {
  Body,
  BadRequestException,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ClaimService } from '../claim/claim.service';
import type { ClaimStatusResponse } from '../claim/claim.types';
import { SessionGuard } from '../session/session.guard';
import { CurrentSession } from '../session/session.decorator';
import type { SessionPayload } from '../session/session.service';

const recheckSchema = z.object({
  method: z.enum(['dns', 'motd']),
  proof: z.string().trim().min(1).max(512),
}).strict();

@Controller('v1/servers/:serverId/verification')
export class ServerVerificationController {
  constructor(
    private readonly claimService: ClaimService,
  ) {}

  @UseGuards(SessionGuard)
  @Post('recheck')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async recheck(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ): Promise<ClaimStatusResponse> {
    const parsed = recheckSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('검증 재점검 요청 형식을 확인해주세요.');
    }
    return this.claimService.verifyMethod(
      serverId,
      parsed.data.method,
      parsed.data.proof,
      session.userId,
    );
  }
}
