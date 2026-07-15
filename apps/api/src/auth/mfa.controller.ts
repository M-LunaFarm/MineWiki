import { Body, Controller, Delete, Get, Post, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import {
  STEP_UP_PURPOSES,
  type SessionPayload,
} from '../session/session.service';
import { MfaService } from './mfa.service';

const totpCodeSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/u),
});
const stepUpSchema = z.object({
  method: z.enum(['totp', 'recovery_code']),
  purpose: z.enum(STEP_UP_PURPOSES),
  code: z.string().trim().min(6).max(64),
});

@Controller('v1/auth/mfa')
@UseGuards(SessionGuard)
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Get()
  getStatus(@CurrentSession() session: SessionPayload) {
    return this.mfa.getStatus(session.userId);
  }

  @Post('totp/enrollment')
  @Throttle({ default: { limit: 3, ttl: 600 } })
  beginTotpEnrollment(@CurrentSession() session: SessionPayload) {
    return this.mfa.beginTotpEnrollment(session);
  }

  @Post('totp/enrollment/confirm')
  @Throttle({ default: { limit: 5, ttl: 600 } })
  async confirmTotpEnrollment(
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const payload = totpCodeSchema.parse(body);
    const result = await this.mfa.confirmTotpEnrollment(session, payload.code);
    reply.header('Set-Cookie', result.session.cookie);
    return {
      enabled: true,
      recoveryCodes: result.recoveryCodes,
      stepUpExpiresAt: result.session.stepUpExpiresAt ?? null,
    };
  }

  @Post('step-up')
  @Throttle({ default: { limit: 5, ttl: 900 } })
  async stepUp(
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const payload = stepUpSchema.parse(body);
    const result = await this.mfa.stepUp(session, {
      method: payload.method!,
      purpose: payload.purpose!,
      code: payload.code!,
    });
    reply.header('Set-Cookie', result.session.cookie);
    return {
      authLevel: 'aal2' as const,
      purpose: payload.purpose,
      expiresAt: result.session.stepUpExpiresAt ?? null,
    };
  }

  @Post('recovery-codes/regenerate')
  @Throttle({ default: { limit: 2, ttl: 3600 } })
  async regenerateRecoveryCodes(
    @CurrentSession() session: SessionPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.mfa.regenerateRecoveryCodes(session);
    reply.header('Set-Cookie', result.session.cookie);
    return { recoveryCodes: result.recoveryCodes };
  }

  @Delete('totp')
  @Throttle({ default: { limit: 2, ttl: 3600 } })
  async disableTotp(
    @CurrentSession() session: SessionPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.mfa.disableTotp(session);
    reply.header('Set-Cookie', result.session.cookie);
    return { enabled: false };
  }
}
