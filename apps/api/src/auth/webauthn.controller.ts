import {
  Body,
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import { STEP_UP_PURPOSES, type SessionPayload } from '../session/session.service';
import { WebAuthnService } from './webauthn.service';

const base64Url = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/u);
const transports = z.array(z.enum([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
])).max(7);
const clientExtensionResults = z.record(z.unknown()).refine(
  (value) => JSON.stringify(value).length <= 16_384,
  'Client extension results are too large.',
);
const publicKeyCredentialBase = {
  id: base64Url(512),
  rawId: base64Url(512),
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['cross-platform', 'platform']).optional(),
  clientExtensionResults,
};

const registrationResponseSchema = z.object({
  ...publicKeyCredentialBase,
  response: z.object({
    clientDataJSON: base64Url(16_384),
    attestationObject: base64Url(262_144),
    authenticatorData: base64Url(16_384).optional(),
    transports: transports.optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64Url(16_384).optional(),
  }).strict(),
}).strict();

const authenticationResponseSchema = z.object({
  ...publicKeyCredentialBase,
  response: z.object({
    clientDataJSON: base64Url(16_384),
    authenticatorData: base64Url(16_384),
    signature: base64Url(16_384),
    userHandle: base64Url(1024).optional(),
  }).strict(),
}).strict();

const registrationVerifySchema = z.object({
  ceremonyId: z.string().uuid(),
  name: z.string().trim().min(1).max(64),
  response: registrationResponseSchema,
}).strict();
const stepUpOptionsSchema = z.object({
  purpose: z.enum(STEP_UP_PURPOSES),
}).strict();
const stepUpVerifySchema = z.object({
  ceremonyId: z.string().uuid(),
  purpose: z.enum(STEP_UP_PURPOSES),
  response: authenticationResponseSchema,
}).strict();

@Controller('v1/auth/mfa/passkeys')
@UseGuards(SessionGuard)
export class WebAuthnController {
  constructor(private readonly webauthn: WebAuthnService) {}

  @Post('registration/options')
  @Throttle({ default: { limit: 5, ttl: 3600 } })
  beginRegistration(@CurrentSession() session: SessionPayload) {
    return this.webauthn.beginRegistration(session);
  }

  @Post('registration/verify')
  @Throttle({ default: { limit: 10, ttl: 3600 } })
  finishRegistration(
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    const payload = registrationVerifySchema.parse(body);
    return this.webauthn.finishRegistration(session, {
      ceremonyId: payload.ceremonyId!,
      name: payload.name!,
      response: payload.response as RegistrationResponseJSON,
    });
  }

  @Post('step-up/options')
  @Throttle({ default: { limit: 10, ttl: 900 } })
  beginStepUp(
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    const payload = stepUpOptionsSchema.parse(body);
    return this.webauthn.beginStepUp(session, payload.purpose);
  }

  @Post('step-up/verify')
  @Throttle({ default: { limit: 10, ttl: 900 } })
  async finishStepUp(
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const payload = stepUpVerifySchema.parse(body);
    const result = await this.webauthn.finishStepUp(session, {
      ceremonyId: payload.ceremonyId!,
      purpose: payload.purpose!,
      response: payload.response as AuthenticationResponseJSON,
    });
    reply.header('Set-Cookie', result.session.cookie);
    return {
      authLevel: 'aal2' as const,
      method: 'webauthn' as const,
      purpose: result.purpose,
      expiresAt: result.session.stepUpExpiresAt ?? null,
    };
  }

  @Delete(':passkeyId')
  @Throttle({ default: { limit: 5, ttl: 3600 } })
  async deletePasskey(
    @Param('passkeyId', new ParseUUIDPipe()) passkeyId: string,
    @CurrentSession() session: SessionPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.webauthn.deletePasskey(session, passkeyId);
    reply.header('Set-Cookie', result.session.cookie);
    return { deleted: true };
  }
}
