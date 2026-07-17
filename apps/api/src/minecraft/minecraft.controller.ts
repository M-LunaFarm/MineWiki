import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  minecraftAuthorizationStartRequestSchema,
  minecraftVerificationRequestSchema,
  type MinecraftAuthorizationStartRequest,
  type MinecraftAuthorizationStartResponse,
  type MinecraftVerificationRequest
} from '@minewiki/schemas';
import {
  MinecraftService,
  type MinecraftIdentity
} from './minecraft.service';
import { SessionGuard } from '../session/session.guard';
import { CurrentSession } from '../session/session.decorator';
import type { SessionPayload } from '../session/session.service';

const RECENT_AUTHENTICATION_WINDOW_MS = 15 * 60 * 1000;

@UseGuards(SessionGuard)
@Controller('v1/minecraft')
export class MinecraftController {
  constructor(private readonly minecraftService: MinecraftService) {}

  @Post('oauth/start')
  @Throttle({ default: { limit: 6, ttl: 60 } })
  startOAuth(
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ): Promise<MinecraftAuthorizationStartResponse> {
    this.assertRecentAuthentication(session);
    const payload: MinecraftAuthorizationStartRequest =
      minecraftAuthorizationStartRequestSchema.parse(body);
    return this.minecraftService.startAuthorization({
      ...payload,
      userId: session.userId
    });
  }

  @Post('verify')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  verify(
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ): Promise<MinecraftIdentity> {
    const payload: MinecraftVerificationRequest = minecraftVerificationRequestSchema.parse(body);
    return this.minecraftService.verifyOwnership({
      ...payload,
      userId: session.userId
    });
  }

  @Get('identity')
  getOwnIdentity(@CurrentSession() session: SessionPayload): Promise<MinecraftIdentity> {
    return this.minecraftService.getIdentity(session.userId);
  }

  @Get('identities')
  getOwnIdentities(@CurrentSession() session: SessionPayload): Promise<{ identities: MinecraftIdentity[] }> {
    return this.minecraftService.getIdentities(session.userId).then((identities) => ({ identities }));
  }

  @Delete('identity')
  @HttpCode(204)
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async revokeOwnIdentity(@CurrentSession() session: SessionPayload): Promise<void> {
    this.assertRecentAuthentication(session);
    await this.minecraftService.revokeIdentity(session.userId);
  }

  @Delete('identities/:minecraftUuid')
  @HttpCode(204)
  @Throttle({ default: { limit: 8, ttl: 300 } })
  async revokeSelectedIdentity(
    @Param('minecraftUuid', new ParseUUIDPipe()) minecraftUuid: string,
    @CurrentSession() session: SessionPayload,
  ): Promise<void> {
    this.assertRecentAuthentication(session);
    await this.minecraftService.revokeIdentity(session.userId, minecraftUuid);
  }

  @Get('identity/:userId')
  getIdentity(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @CurrentSession() session: SessionPayload
  ): Promise<MinecraftIdentity> {
    if (userId !== session.userId) {
      throw new ForbiddenException('본인 계정만 조회할 수 있습니다.');
    }
    return this.minecraftService.getIdentity(userId);
  }

  private assertRecentAuthentication(session: SessionPayload): void {
    const authenticatedAt = new Date(session.authenticatedAt);
    const age = Date.now() - authenticatedAt.getTime();
    if (
      Number.isNaN(authenticatedAt.getTime()) ||
      age < 0 ||
      age > RECENT_AUTHENTICATION_WINDOW_MS
    ) {
      throw new ForbiddenException(
        '보안을 위해 다시 로그인한 뒤 15분 안에 Minecraft 인증을 진행해 주세요.'
      );
    }
  }
}
