import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { SessionService, type SessionPayload, type SessionRecord } from './session.service';
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

declare module 'fastify' {
  interface FastifyRequest {
    sessionPayload?: SessionPayload;
    sessionToken?: string;
    rateLimitSessionRecord?: SessionRecord | null;
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const requestIp = request.clientIp ?? null;
    const token = parseCookie(request.headers.cookie, 'mw_session');
    const session = request.rateLimitSessionRecord === undefined
      ? await this.sessions.getSessionByToken(token)
      : request.rateLimitSessionRecord ?? undefined;
    if (!session) {
      throw new UnauthorizedException('로그인이 필요합니다.');
    }
    await this.sessions.touchSession(
      session.sessionId,
      requestIp,
      request.headers['user-agent'] ?? null
    );
    assertCsrfToken(request, session.token);
    const payload = { ...this.sessions.toPayload(session), requestIp };
    if (payload.policyConsent?.required && !isPolicyConsentExempt(request)) {
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

function isPolicyConsentExempt(request: FastifyRequest): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
    return true;
  }
  const pathname = request.url.split('?', 1)[0]?.replace(/\/$/, '');
  return pathname === '/v1/auth/policies/accept' || pathname === '/v1/auth/logout';
}
