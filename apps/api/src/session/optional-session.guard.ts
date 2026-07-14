import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { extractClientIp } from '../common/http/client-ip';
import { SessionService } from './session.service';
import { assertCsrfToken } from './csrf';

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  const parts = header.split(';');
  for (const part of parts) {
    const [key, value] = part.trim().split('=');
    if (key === name) {
      return decodeURIComponent(value ?? '');
    }
  }
  return undefined;
}

@Injectable()
export class OptionalSessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = parseCookie(request.headers.cookie, 'mw_session');
    const session = await this.sessions.getSessionByToken(token);
    if (!session) {
      return true;
    }
    await this.sessions.touchSession(
      session.sessionId,
      extractClientIp(request) ?? null,
      request.headers['user-agent'] ?? null
    );
    assertCsrfToken(request, session.token);
    const payload = this.sessions.toPayload(session);
    if (
      payload.policyConsent?.required &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())
    ) {
      throw new ForbiddenException({
        code: 'POLICY_CONSENT_REQUIRED',
        message: '개정된 이용약관과 개인정보 처리방침에 동의해 주세요.',
        policyConsent: payload.policyConsent,
      });
    }
    request.sessionPayload = payload;
    request.sessionToken = session.token;
    return true;
  }
}
