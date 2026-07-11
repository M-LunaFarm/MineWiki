import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
  BadRequestException
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SessionService } from './session.service';
import { SessionGuard } from './session.guard';
import { CurrentSession } from './session.decorator';
import type { SessionPayload } from './session.service';

@Controller('v1/sessions')
@UseGuards(SessionGuard)
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  @Get()
  async listSessions(@CurrentSession() session: SessionPayload) {
    const summaries = await this.sessions.listSessionsForUser(
      session.userId,
      session.sessionId
    );
    return {
      sessions: summaries.map((item) => ({
        sessionId: item.sessionId,
        createdAt: item.createdAt,
        lastActiveAt: item.lastActiveAt,
        ipAddress: item.ipAddress,
        userAgent: item.userAgent,
        isCurrent: item.isCurrent,
        tokenVersion: item.tokenVersion,
        isElevated: item.isElevated
      }))
    };
  }

  @Delete('others')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async revokeOtherSessions(@CurrentSession() session: SessionPayload) {
    await this.sessions.revokeAllSessions(session.userId, session.sessionId);
    return { success: true };
  }

  @Delete(':sessionId')
  @Throttle({ default: { limit: 10, ttl: 300 } })
  async revokeSession(
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @CurrentSession() session: SessionPayload
  ) {
    if (session.sessionId === sessionId) {
      throw new BadRequestException('현재 사용 중인 세션은 여기서 해제할 수 없습니다.');
    }
    await this.sessions.revokeUserSession(session.userId, sessionId);
    return { success: true };
  }
}
