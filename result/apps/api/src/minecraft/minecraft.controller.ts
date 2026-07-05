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

@UseGuards(SessionGuard)
@Controller('v1/minecraft')
export class MinecraftController {
  constructor(private readonly minecraftService: MinecraftService) {}

  @Post('oauth/start')
  startOAuth(
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ): Promise<MinecraftAuthorizationStartResponse> {
    const payload: MinecraftAuthorizationStartRequest =
      minecraftAuthorizationStartRequestSchema.parse(body);
    return this.minecraftService.startAuthorization({
      ...payload,
      userId: session.userId
    });
  }

  @Post('verify')
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

  @Delete('identity')
  @HttpCode(204)
  async revokeOwnIdentity(@CurrentSession() session: SessionPayload): Promise<void> {
    await this.minecraftService.revokeIdentity(session.userId);
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
}
