import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler/dist/throttler.guard.interface';
import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { extractClientIp } from '../http/client-ip';

@Injectable()
export class LoggingThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(LoggingThrottlerGuard.name);

  protected override async getTracker(request: Record<string, unknown>): Promise<string> {
    return trackerForRequest(request as unknown as FastifyRequest);
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

export function trackerForRequest(request: FastifyRequest): string {
  const sessionToken = extractCookie(request.headers.cookie, 'mw_session');
  if (sessionToken) {
    return `session:${sha256(sessionToken)}`;
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
