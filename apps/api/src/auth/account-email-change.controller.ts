import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { contactEmailChangeConfirmSchema, contactEmailChangeRequestSchema } from '@minewiki/schemas';
import type { FastifyReply } from 'fastify';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { AccountEmailChangeService } from './account-email-change.service';

@Controller('v1/auth')
export class AccountEmailChangeController {
  constructor(private readonly emailChanges: AccountEmailChangeService) {}

  @Get('me/email-change')
  @UseGuards(SessionGuard)
  getState(@CurrentSession() session: SessionPayload) {
    return this.emailChanges.getState(session);
  }

  @Post('me/email-change/request')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 3, ttl: 600 } })
  request(@CurrentSession() session: SessionPayload, @Body() body: unknown) {
    const input = contactEmailChangeRequestSchema.parse(body);
    return this.emailChanges.request(session, {
      email: input.email!,
      ...(input.password === undefined ? {} : { password: input.password }),
    });
  }

  @Post('me/email-change/resend')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 3, ttl: 600 } })
  resend(@CurrentSession() session: SessionPayload) {
    return this.emailChanges.resend(session);
  }

  @Post('email-change/confirm')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async confirm(@Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = contactEmailChangeConfirmSchema.parse(body);
    const result = await this.emailChanges.confirm(input.token);
    reply.header('Set-Cookie', 'mw_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
    return result;
  }
}
