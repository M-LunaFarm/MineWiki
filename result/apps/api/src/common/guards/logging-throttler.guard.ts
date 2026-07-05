import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler/dist/throttler.guard.interface';
import type { FastifyRequest } from 'fastify';
import { extractClientIp } from '../http/client-ip';

@Injectable()
export class LoggingThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(LoggingThrottlerGuard.name);

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
