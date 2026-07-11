import {
  Body,
  Controller,
  ForbiddenException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards
} from '@nestjs/common';
import { VoteDiagnosticsService, type DiagnosticsResult } from './vote-diagnostics.service';
import { SessionGuard } from '../session/session.guard';
import { CurrentSession } from '../session/session.decorator';
import type { SessionPayload } from '../session/session.service';
import { ClaimService } from '../claim/claim.service';

@Controller('v1/servers/:serverId/votifier')
export class VoteDiagnosticsController {
  constructor(
    private readonly diagnostics: VoteDiagnosticsService,
    private readonly claims: ClaimService
  ) {}

  @UseGuards(SessionGuard)
  @Post('test')
  async runDiagnostics(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ): Promise<DiagnosticsResult> {
    if (
      !session.isElevated &&
      session.permissions?.includes('server.admin') !== true &&
      !(await this.claims.isOwner(serverId, session.userId))
    ) {
      throw new ForbiddenException('해당 서버의 Votifier 진단을 실행할 권한이 없습니다.');
    }
    return this.diagnostics.runDiagnostics(serverId, body);
  }
}
