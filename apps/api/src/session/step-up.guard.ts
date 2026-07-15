import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { assertFreshStepUp, type StepUpPurpose } from './session.service';

export const STEP_UP_PURPOSE_METADATA = 'minewiki:step-up-purpose';

@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const purpose = this.reflector.getAllAndOverride<StepUpPurpose>(
      STEP_UP_PURPOSE_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!purpose) {
      throw new InternalServerErrorException('Step-up policy metadata is missing.');
    }
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!request.sessionPayload) {
      throw new UnauthorizedException('로그인이 필요합니다.');
    }
    assertFreshStepUp(request.sessionPayload, purpose);
    return true;
  }
}
