import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { SessionPayload } from './session.service';

export const CurrentSession = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): SessionPayload => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (!request.sessionPayload) {
      throw new Error('세션 정보가 설정되지 않았습니다.');
    }
    return request.sessionPayload;
  }
);
