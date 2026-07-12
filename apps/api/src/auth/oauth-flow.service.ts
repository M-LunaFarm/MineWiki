import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import type { OAuthProvider } from '@minewiki/schemas';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { encryptAppSecret } from '../common/secret-codec';

interface PendingOAuthState {
  readonly provider: OAuthProvider;
  readonly redirectUri: string;
  readonly returnTo?: string;
  readonly mode: 'login' | 'link';
  readonly linkAccountId?: string;
  readonly agreeTerms: boolean;
  readonly agreePrivacy: boolean;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

interface OAuthStartResult {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly expiresAt: string;
}

interface OAuthCompleteResult {
  readonly providerUserId: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly returnTo?: string;
  readonly mode: 'login' | 'link';
  readonly linkAccountId?: string;
  readonly agreeTerms: boolean;
  readonly agreePrivacy: boolean;
  readonly credential?: OAuthCredentialSnapshot;
}

type OAuthProfile = Pick<OAuthCompleteResult, 'providerUserId' | 'email' | 'displayName'>;

interface OAuthCredentialSnapshot {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType?: string;
  readonly scope?: string;
  readonly expiresAt?: Date;
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export type { OAuthStartResult, OAuthCompleteResult };

@Injectable()
export class OAuthFlowService {
  private readonly logger = new Logger(OAuthFlowService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService
  ) {}

  async start(
    provider: OAuthProvider,
    redirectUri?: string,
    returnTo?: string,
    mode: 'login' | 'link' = 'login',
    linkAccountId?: string,
    agreeTerms = false,
    agreePrivacy = false
  ): Promise<OAuthStartResult> {
    await this.evictExpiredStates();
    const state = this.generateState();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + STATE_TTL_MS);
    const normalizedRedirect =
      redirectUri ?? this.getFallbackRedirect(provider) ?? this.throwMissingRedirect(provider);
    const url =
      provider === 'discord'
        ? this.createDiscordAuthorizationUrl(state, normalizedRedirect)
        : this.createNaverAuthorizationUrl(state, normalizedRedirect);
    const sanitizedReturnTo = this.sanitizeReturnTo(returnTo);

    if (mode === 'link' && !linkAccountId) {
      throw new BadRequestException('OAuth link requires an account context.');
    }

    await this.prisma.oAuthState.create({
      data: {
        state,
        provider,
        redirectUri: normalizedRedirect,
        returnTo: sanitizedReturnTo,
        createdAt: now,
        expiresAt,
        mode,
        linkAccountId: linkAccountId ?? null
        ,agreeTerms
        ,agreePrivacy
      }
    });

    return {
      authorizationUrl: url,
      state,
      expiresAt: expiresAt.toISOString()
    };
  }

  async complete(
    provider: OAuthProvider,
    code: string,
    state: string,
    redirectUri?: string
  ): Promise<OAuthCompleteResult> {
    await this.evictExpiredStates();
    const pending = await this.consumeState(state, provider);
    if (redirectUri && redirectUri !== pending.redirectUri) {
      throw new BadRequestException('OAuth 리디렉션 URI가 일치하지 않습니다.');
    }

    const effectiveRedirect = pending.redirectUri;
    if (provider === 'discord') {
      const profile = await this.exchangeDiscordCode(code, effectiveRedirect);
      return {
        ...profile,
        returnTo: pending.returnTo,
        mode: pending.mode,
        linkAccountId: pending.linkAccountId
        ,agreeTerms: pending.agreeTerms
        ,agreePrivacy: pending.agreePrivacy
      };
    }
    const profile = await this.exchangeNaverCode(code, state, effectiveRedirect);
    return {
      ...profile,
      returnTo: pending.returnTo,
      mode: pending.mode,
      linkAccountId: pending.linkAccountId
      ,agreeTerms: pending.agreeTerms
      ,agreePrivacy: pending.agreePrivacy
    };
  }

  private createDiscordAuthorizationUrl(state: string, redirectUri: string): string {
    const clientId = this.config.getOptional('DISCORD_CLIENT_ID');
    if (!clientId) {
      throw new InternalServerErrorException('DISCORD_CLIENT_ID가 설정되지 않았습니다.');
    }
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify email guilds');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  private async exchangeDiscordCode(
    code: string,
    redirectUri: string
  ): Promise<OAuthProfile & { credential: OAuthCredentialSnapshot }> {
    const clientId = this.config.getOptional('DISCORD_CLIENT_ID');
    const clientSecret = this.config.getOptional('DISCORD_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new InternalServerErrorException('Discord OAuth 환경 변수가 설정되지 않았습니다.');
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    });

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }).catch((error) => {
      this.logger.error({ err: error }, 'Discord 토큰 요청 실패');
      throw new UnauthorizedException('Discord OAuth 요청에 실패했습니다.');
    });

    if (!tokenResponse.ok) {
      this.logger.warn({ status: tokenResponse.status }, 'Discord 토큰 교환 실패');
      throw new UnauthorizedException('Discord OAuth 코드가 유효하지 않습니다.');
    }

    const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
      scope?: string;
    };

    if (!tokenPayload?.access_token) {
      throw new UnauthorizedException('Discord 액세스 토큰을 받지 못했습니다.');
    }

    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`
      }
    }).catch((error) => {
      this.logger.error({ err: error }, 'Discord 사용자 정보 요청 실패');
      throw new UnauthorizedException('Discord 사용자 정보를 확인할 수 없습니다.');
    });

    if (!userResponse.ok) {
      this.logger.warn({ status: userResponse.status }, 'Discord 사용자 정보 조회 실패');
      throw new UnauthorizedException('Discord 사용자 정보를 확인할 수 없습니다.');
    }

    const user = (await userResponse.json().catch(() => ({}))) as {
      id?: string;
      username?: string;
      global_name?: string;
      email?: string;
    };

    if (!user?.id) {
      throw new UnauthorizedException('Discord 사용자 식별자를 찾을 수 없습니다.');
    }

    return {
      providerUserId: user.id,
      email: user.email?.toLowerCase(),
      displayName: user.global_name ?? user.username ?? undefined,
      credential: {
        accessToken: tokenPayload.access_token,
        refreshToken: tokenPayload.refresh_token,
        tokenType: tokenPayload.token_type,
        scope: tokenPayload.scope,
        expiresAt: tokenPayload.expires_in
          ? new Date(Date.now() + tokenPayload.expires_in * 1000)
          : undefined
      }
    };
  }

  async storeCredential(
    accountId: string,
    provider: OAuthProvider,
    providerUserId: string,
    credential?: OAuthCredentialSnapshot
  ): Promise<void> {
    if (!credential?.accessToken) {
      return;
    }
    await this.prisma.oAuthCredential.upsert({
      where: {
        accountId_provider_providerUserId: {
          accountId,
          provider,
          providerUserId
        }
      },
      create: {
        accountId,
        provider,
        providerUserId,
        accessToken: encryptAppSecret(credential.accessToken) ?? credential.accessToken,
        refreshToken: encryptAppSecret(credential.refreshToken),
        tokenType: credential.tokenType ?? null,
        scope: credential.scope ?? null,
        expiresAt: credential.expiresAt ?? null
      },
      update: {
        accessToken: encryptAppSecret(credential.accessToken) ?? credential.accessToken,
        refreshToken: encryptAppSecret(credential.refreshToken),
        tokenType: credential.tokenType ?? null,
        scope: credential.scope ?? null,
        expiresAt: credential.expiresAt ?? null
      }
    });
  }

  private createNaverAuthorizationUrl(state: string, redirectUri: string): string {
    const clientId = this.config.getOptional('NAVER_CLIENT_ID');
    if (!clientId) {
      throw new InternalServerErrorException('NAVER_CLIENT_ID가 설정되지 않았습니다.');
    }
    const url = new URL('https://nid.naver.com/oauth2.0/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'profile');
    return url.toString();
  }

  private async exchangeNaverCode(
    code: string,
    state: string,
    redirectUri: string
  ): Promise<OAuthProfile> {
    const clientId = this.config.getOptional('NAVER_CLIENT_ID');
    const clientSecret = this.config.getOptional('NAVER_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new InternalServerErrorException('NAVER OAuth 환경 변수가 설정되지 않았습니다.');
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      state,
      redirect_uri: redirectUri
    });

    const tokenResponse = await fetch('https://nid.naver.com/oauth2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }).catch((error) => {
      this.logger.error({ err: error }, 'NAVER 토큰 요청 실패');
      throw new UnauthorizedException('NAVER OAuth 요청에 실패했습니다.');
    });

    if (!tokenResponse.ok) {
      this.logger.warn({ status: tokenResponse.status }, 'NAVER 토큰 교환 실패');
      throw new UnauthorizedException('NAVER OAuth 코드가 유효하지 않습니다.');
    }

    const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as {
      access_token?: string;
      token_type?: string;
    };

    if (!tokenPayload?.access_token) {
      throw new UnauthorizedException('NAVER 액세스 토큰을 받지 못했습니다.');
    }

    const userResponse = await fetch('https://openapi.naver.com/v1/nid/me', {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`
      }
    }).catch((error) => {
      this.logger.error({ err: error }, 'NAVER 사용자 정보 요청 실패');
      throw new UnauthorizedException('NAVER 사용자 정보를 확인할 수 없습니다.');
    });

    if (!userResponse.ok) {
      this.logger.warn({ status: userResponse.status }, 'NAVER 사용자 정보 조회 실패');
      throw new UnauthorizedException('NAVER 사용자 정보를 확인할 수 없습니다.');
    }

    const data = (await userResponse.json().catch(() => ({}))) as {
      response?: {
        id?: string;
        email?: string;
        nickname?: string;
        name?: string;
      };
    };

    const user = data.response;
    if (!user?.id) {
      throw new UnauthorizedException('NAVER 사용자 식별자를 찾을 수 없습니다.');
    }

    return {
      providerUserId: user.id,
      email: user.email?.toLowerCase(),
      displayName: user.nickname ?? user.name ?? undefined
    };
  }

  private async consumeState(state: string, provider: OAuthProvider): Promise<PendingOAuthState> {
    const pending = await this.prisma.oAuthState.findUnique({
      where: { state }
    });
    if (!pending) {
      throw new BadRequestException('만료되었거나 유효하지 않은 OAuth 상태입니다.');
    }
    if (pending.provider !== provider) {
      throw new BadRequestException('OAuth 공급자 정보가 일치하지 않습니다.');
    }
    await this.prisma.oAuthState.delete({ where: { state } });
    return {
      provider: pending.provider,
      redirectUri: pending.redirectUri,
      returnTo: pending.returnTo ?? undefined,
      mode: pending.mode,
      linkAccountId: pending.linkAccountId ?? undefined,
      agreeTerms: pending.agreeTerms,
      agreePrivacy: pending.agreePrivacy,
      createdAt: pending.createdAt,
      expiresAt: pending.expiresAt
    };
  }

  private async evictExpiredStates(): Promise<void> {
    await this.prisma.oAuthState.deleteMany({
      where: { expiresAt: { lt: new Date() } }
    });
  }

  private generateState(): string {
    return randomBytes(24).toString('hex');
  }

  private getFallbackRedirect(provider: OAuthProvider): string | undefined {
    if (provider === 'discord') {
      return this.config.getOptional('DISCORD_REDIRECT_URI');
    }
    return this.config.getOptional('NAVER_REDIRECT_URI');
  }

  private throwMissingRedirect(provider: OAuthProvider): never {
    if (provider === 'discord') {
      throw new InternalServerErrorException('Discord OAuth 리디렉션 URI가 설정되지 않았습니다.');
    }
    throw new InternalServerErrorException('NAVER OAuth 리디렉션 URI가 설정되지 않았습니다.');
  }

  private sanitizeReturnTo(returnTo?: string): string | undefined {
    if (!returnTo) {
      return undefined;
    }
    if (returnTo.startsWith('/') && !returnTo.startsWith('//')) {
      return returnTo;
    }
    try {
      const url = new URL(returnTo);
      const normalized = `${url.pathname}${url.search}${url.hash}`.trim();
      if (!normalized) {
        return undefined;
      }
      return normalized.startsWith('/') ? normalized : `/${normalized}`;
    } catch {
      return undefined;
    }
  }
}
