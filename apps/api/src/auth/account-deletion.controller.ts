import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { accountDeletionCancelSchema, accountDeletionRequestSchema } from '@minewiki/schemas';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { AccountDeletionService } from './account-deletion.service';

@Controller('v1/auth/account-deletion')
export class AccountDeletionController {
  constructor(private readonly deletions: AccountDeletionService) {}

  @Get()
  @UseGuards(SessionGuard)
  status(@CurrentSession() session: SessionPayload) {
    return this.deletions.getStatus(session.userId);
  }

  @Post()
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 3, ttl: 3600 } })
  async request(@CurrentSession() session: SessionPayload, @Body() body: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const payload = accountDeletionRequestSchema.parse(body);
    const result = await this.deletions.requestDeletion({ session, password: payload.password, ipAddress: request.clientIp ?? null, userAgent: request.headers['user-agent'] ?? null });
    reply.header('Set-Cookie', 'mw_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
    return result;
  }

  @Post('cancel')
  @Throttle({ default: { limit: 5, ttl: 3600 } })
  cancel(@Body() body: unknown) {
    const payload = accountDeletionCancelSchema.parse(body);
    return this.deletions.cancel(payload.cancelToken);
  }
}
