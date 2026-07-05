import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  Req,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthService,
  type AuthSessionResult,
  type EmailRegistrationResult,
  type PasswordResetConfirmResult,
  type PasswordResetRequestResult,
  type ResendVerificationResult,
} from './auth.service';
import { SessionGuard } from '../session/session.guard';
import { CurrentSession } from '../session/session.decorator';
import { SessionService, type SessionPayload } from '../session/session.service';
import {
  oauthStartRequestSchema,
  oauthCompleteRequestSchema,
  type OAuthProvider,
} from '@minewiki/schemas';
import { OAuthFlowService } from './oauth-flow.service';
import { extractClientIp } from '../common/http/client-ip';
import { decodeBase64 } from '../upload/upload.utils';

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly oauthFlow: OAuthFlowService,
  ) {}

  @Post('oauth/start')
  startOAuth(@Body() body: unknown) {
    const payload = oauthStartRequestSchema.parse(body);
    return this.oauthFlow.start(payload.provider, payload.redirectUri, payload.returnTo);
  }

  @UseGuards(SessionGuard)
  @Post('oauth/link')
  startOAuthLink(@Body() body: unknown, @CurrentSession() session: SessionPayload) {
    const payload = oauthStartRequestSchema.parse(body);
    return this.oauthFlow.start(
      payload.provider,
      payload.redirectUri,
      payload.returnTo,
      'link',
      session.userId,
    );
  }

  @Post('oauth/complete')
  async completeOAuth(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ) {
    const payload = oauthCompleteRequestSchema.parse(body);
    const profile = await this.oauthFlow.complete(
      payload.provider,
      payload.code,
      payload.state,
      payload.redirectUri,
    );
    if (profile.mode === 'link') {
      const sessionRecord = await this.getOptionalSession(request);
      if (!sessionRecord || sessionRecord.userId !== profile.linkAccountId) {
        throw new UnauthorizedException('로그인이 필요합니다.');
      }
      const account = await this.auth.linkOAuthAccount(sessionRecord.userId, payload.provider, {
        userId: profile.providerUserId,
        email: profile.email,
        displayName: profile.displayName,
      });
      return {
        account,
        sessionId: sessionRecord.sessionId,
        expiresAt: sessionRecord.expiresAt.toISOString(),
        returnTo: profile.returnTo ?? null,
        mode: 'link',
      };
    }

    const session = await this.finalizeOAuth(payload.provider, profile, reply, request);
    return {
      account: session.account,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      returnTo: profile.returnTo ?? null,
      mode: 'login',
    };
  }

  @Post('email/register')
  registerEmail(
    @Body('email') email: string,
    @Body('password') password: string,
    @Body('displayName') displayName: string | undefined,
  ): Promise<EmailRegistrationResult> {
    return this.auth.registerEmail({ email, password, displayName });
  }

  @Post('email/login')
  async loginEmail(
    @Body('email') email: string,
    @Body('password') password: string,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ) {
    const result = await this.auth.loginEmail(
      { email, password },
      this.extractSessionContext(request),
    );
    reply.header('Set-Cookie', result.cookie);
    return {
      account: result.account,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
    };
  }

  @Post('email/verify')
  async verifyEmail(
    @Body('token') token: string,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ) {
    const result = await this.auth.verifyEmail(token, this.extractSessionContext(request));
    reply.header('Set-Cookie', result.cookie);
    return {
      account: result.account,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
    };
  }

  @Post('email/resend')
  resendVerification(@Body('email') email: string): Promise<ResendVerificationResult> {
    return this.auth.resendVerification(email);
  }

  @UseGuards(SessionGuard)
  @Post('email/setup')
  setupEmailLogin(
    @CurrentSession() session: SessionPayload,
    @Body('email') email: string,
    @Body('password') password: string,
  ): Promise<ResendVerificationResult> {
    return this.auth.setupEmailLogin(session.userId, { email, password });
  }

  @Post('password/forgot')
  requestPasswordReset(@Body('email') email: string): Promise<PasswordResetRequestResult> {
    return this.auth.requestPasswordReset(email ?? '');
  }

  @Post('password/reset')
  resetPassword(
    @Body('token') token: string,
    @Body('newPassword') newPassword: string,
  ): Promise<PasswordResetConfirmResult> {
    return this.auth.resetPassword(token ?? '', newPassword ?? '');
  }

  @Post('discord/callback')
  async discordCallback(
    @Body('userId') userId: string,
    @Body('email') email: string | undefined,
    @Body('username') username: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ) {
    const result = await this.auth.handleDiscordCallback(
      {
        userId,
        email,
        displayName: username,
      },
      this.extractSessionContext(request),
    );
    reply.header('Set-Cookie', result.cookie);
    return {
      account: result.account,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
    };
  }

  @Post('naver/callback')
  async naverCallback(
    @Body('userId') userId: string,
    @Body('email') email: string | undefined,
    @Body('nickname') nickname: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ) {
    const result = await this.auth.handleNaverCallback(
      {
        userId,
        email,
        displayName: nickname,
      },
      this.extractSessionContext(request),
    );
    reply.header('Set-Cookie', result.cookie);
    return {
      account: result.account,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
    };
  }

  private async finalizeOAuth(
    provider: OAuthProvider,
    profile: { providerUserId: string; email?: string; displayName?: string },
    reply: FastifyReply,
    request: FastifyRequest,
  ): Promise<AuthSessionResult> {
    const handler =
      provider === 'discord'
        ? this.auth.handleDiscordCallback.bind(this.auth)
        : this.auth.handleNaverCallback.bind(this.auth);
    const result = await handler(
      {
        userId: profile.providerUserId,
        email: profile.email,
        displayName: profile.displayName,
      },
      this.extractSessionContext(request),
    );
    reply.header('Set-Cookie', result.cookie);
    return result;
  }

  @Post('link-requests')
  createLinkRequest(
    @Body('primaryAccountId') primaryAccountId: string,
    @Body('targetAccountId') targetAccountId: string,
  ) {
    return this.auth.createLinkRequest(primaryAccountId, targetAccountId);
  }

  @Post('link-requests/:requestId/confirm')
  confirmLink(
    @Param('requestId') requestId: string,
    @Body('verificationCode') verificationCode: string,
  ) {
    return this.auth.confirmLink(requestId, verificationCode);
  }

  @UseGuards(SessionGuard)
  @Get('me')
  me(@CurrentSession() session: SessionPayload) {
    return this.auth.getAccountView(session.userId);
  }

  @UseGuards(SessionGuard)
  @Patch('me')
  updateDisplayName(
    @CurrentSession() session: SessionPayload,
    @Body('displayName') displayName: string,
  ) {
    return this.auth.updateDisplayName(session.userId, displayName ?? '');
  }

  @UseGuards(SessionGuard)
  @Post('me/avatar')
  updateAvatar(
    @CurrentSession() session: SessionPayload,
    @Body('data') data: string,
    @Body('filename') filename?: string,
  ) {
    if (!data?.trim()) {
      throw new BadRequestException('이미지 데이터가 필요합니다.');
    }

    const buffer = decodeBase64(data);
    return this.auth.updateAvatar(session.userId, {
      buffer,
      filename: filename?.trim() ? filename.trim() : undefined,
    });
  }

  @UseGuards(SessionGuard)
  @Delete('me/avatar')
  clearAvatar(@CurrentSession() session: SessionPayload) {
    return this.auth.clearAvatar(session.userId);
  }

  @UseGuards(SessionGuard)
  @Patch('password')
  async changePassword(
    @CurrentSession() session: SessionPayload,
    @Body('currentPassword') currentPassword: string,
    @Body('newPassword') newPassword: string,
  ) {
    await this.auth.changePassword(session.userId, currentPassword ?? '', newPassword ?? '');
    return { success: true };
  }

  @UseGuards(SessionGuard)
  @Post('logout')
  async logout(
    @CurrentSession() session: SessionPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.sessions.revokeSession(session.sessionId);
    reply.header('Set-Cookie', 'mw_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
    return { success: true };
  }

  @Get('providers')
  providers() {
    return this.auth.getOAuthProviderAvailability();
  }

  @Get('accounts/:accountId')
  getAccount(@Param('accountId', new ParseUUIDPipe()) accountId: string) {
    return this.auth.getAccountView(accountId);
  }

  private extractSessionContext(request: FastifyRequest) {
    return {
      ipAddress: extractClientIp(request) ?? null,
      userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
    };
  }

  private async getOptionalSession(request: FastifyRequest) {
    const token = extractSessionToken(request);
    if (!token) {
      return undefined;
    }
    return this.sessions.getSessionByToken(token);
  }
}

function extractSessionToken(request: FastifyRequest): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(';')) {
    const [key, value] = part.trim().split('=');
    if (key === 'mw_session') {
      return decodeURIComponent(value ?? '');
    }
  }
  return undefined;
}
