import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ForbiddenException } from '@nestjs/common';
import { ClaimService } from './claim.service';
import type { ClaimMethod, ClaimMethodStatus, ClaimStatusResponse } from './claim.types';
import { SessionGuard } from '../session/session.guard';
import { CurrentSession } from '../session/session.decorator';
import type { SessionPayload } from '../session/session.service';

const METHODS: ClaimMethod[] = ['dns', 'motd'];
interface StartRequest {
  readonly methods?: ClaimMethod[];
}

interface VerifyRequest {
  readonly method: ClaimMethod;
  readonly proof: string;
}

@UseGuards(SessionGuard)
@Controller('v1/servers/:serverId/claim')
export class ClaimController {
  constructor(private readonly claimService: ClaimService) {}

  @Post('start')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async start(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: StartRequest,
    @CurrentSession() session: SessionPayload
  ): Promise<ClaimMethodStatus[]> {
    validateMethods(body.methods);
    return this.claimService.issueTokens(serverId, session.userId, body.methods);
  }

  @Post('verify')
  @Throttle({ default: { limit: 10, ttl: 300 } })
  async verify(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: VerifyRequest,
    @CurrentSession() session: SessionPayload
  ): Promise<ClaimStatusResponse> {
    if (!body?.method || !METHODS.includes(body.method)) {
      throw new BadRequestException('허용되지 않는 검증 방식입니다.');
    }
    if (!body.proof || body.proof.trim().length === 0) {
      throw new BadRequestException('검증 토큰을 입력해주세요.');
    }
    return this.claimService.verifyMethod(
      serverId,
      body.method,
      body.proof.trim(),
      session.userId
    );
  }

  @Get('status')
  async status(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @CurrentSession() session: SessionPayload
  ): Promise<ClaimStatusResponse> {
    if (!(await this.claimService.canAccessClaim(serverId, session.userId))) {
      throw new ForbiddenException('해당 서버의 검증 상태를 조회할 권한이 없습니다.');
    }
    return this.claimService.getStatus(serverId);
  }
}

function validateMethods(methods?: ClaimMethod[]): void {
  if (!methods) {
    return;
  }
  const invalid = methods.filter((method) => !METHODS.includes(method));
  if (invalid.length > 0) {
    throw new BadRequestException(`허용되지 않는 검증 방식입니다. ${invalid.join(', ')}`);
  }
}
