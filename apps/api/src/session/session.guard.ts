import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { SessionService, type SessionPayload } from './session.service';
import { extractClientIp } from '../common/http/client-ip';

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
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = parseCookie(request.headers.cookie, 'mw_session');
    const session = await this.sessions.getSessionByToken(token);
    if (!session) {
      throw new UnauthorizedException('濡쒓렇?몄씠 ?꾩슂?⑸땲??');
    }
    await this.sessions.touchSession(
      session.sessionId,
      extractClientIp(request) ?? null,
      request.headers['user-agent'] ?? null
    );
    request.sessionPayload = this.sessions.toPayload(session);
    request.sessionToken = session.token;
    return true;
  }
}
