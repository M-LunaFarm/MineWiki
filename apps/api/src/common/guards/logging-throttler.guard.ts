import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler/dist/throttler.guard.interface';
import type { FastifyRequest } from 'fastify';
import { extractClientIp } from '../http/client-ip';
import { SessionService } from '../../session/session.service';

@Injectable()
export class LoggingThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(LoggingThrottlerGuard.name);

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly sessions: SessionService,
  ) {
    super(options, storage, reflector);
  }

  protected override async getTracker(request: Record<string, unknown>): Promise<string> {
    const fastifyRequest = request as unknown as FastifyRequest;
    return trackerForRequest(fastifyRequest, async (token) => {
      const session = await this.sessions.getSessionByToken(token);
      fastifyRequest.rateLimitSessionRecord = session ?? null;
      return session?.userId ?? null;
    });
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail
  ): Promise<void> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const ip = request ? extractClientIp(request) : undefined;
    const path = request?.originalUrl ?? request?.url;
    this.logger.warn({ ip, path, throttler: throttlerLimitDetail }, 'Rate limit exceeded');
    return super.throwThrottlingException(context, throttlerLimitDetail);
  }
}

export async function trackerForRequest(
  request: FastifyRequest,
  resolveAccountId: (sessionToken: string) => Promise<string | null> = async () => null,
): Promise<string> {
  const sessionToken = extractCookie(request.headers.cookie, 'mw_session');
  if (sessionToken) {
    const accountId = await resolveAccountId(sessionToken);
    if (accountId) return `account:${accountId}`;
  }
  return `ip:${extractClientIp(request) ?? request.ip ?? 'unknown'}`;
}

function extractCookie(header: string | undefined, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const [key, value] = part.trim().split('=');
    if (key === name && value) {
      return decodeURIComponent(value);
    }
  }
  return null;
}
