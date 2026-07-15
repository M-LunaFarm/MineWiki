import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import type { Prisma } from '@prisma/client';
import type { OAuthProvider } from '@minewiki/schemas';
import { randomBytes } from 'node:crypto';
import {
  hashOAuthBrowserBinding,
  matchesOAuthBrowserBinding
} from './oauth-browser-binding';
import { PrismaService } from '../common/prisma.service';
import { decryptAppSecret, encryptAppSecret } from '../common/secret-codec';
import { fetchWithTimeout } from '../common/http/external-fetch';
import { withActiveCanonicalAccountGroup } from './account-lifecycle-fence';
import { hashOAuthSignupTicket } from './oauth-signup-ticket';

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
  readonly browserBindingHash: string;
}

interface OAuthStartResult {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly expiresAt: string;
}

interface OAuthCompleteResult {
  readonly provider: OAuthProvider;
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
const SIGNUP_TTL_MS = 10 * 60 * 1000;
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
    agreePrivacy = false,
    browserBindingHash?: string
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
    if (!browserBindingHash) {
      throw new BadRequestException('OAuth 브라우저 확인 정보가 없습니다. 다시 시도해 주세요.');
    }

    const createState = (store: PrismaService | Prisma.TransactionClient) =>
      store.oAuthState.create({
        data: {
          state,
          provider,
          redirectUri: normalizedRedirect,
          returnTo: sanitizedReturnTo,
          createdAt: now,
          expiresAt,
          mode,
          linkAccountId: linkAccountId ?? null,
          agreeTerms,
          agreePrivacy,
          browserBindingHash
        }
      });

    if (mode === 'link') {
      await withActiveCanonicalAccountGroup(this.prisma, [linkAccountId as string], (tx) =>
        createState(tx)
      );
    } else {
      await createState(this.prisma);
    }

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
    redirectUri?: string,
    browserBinding?: string
  ): Promise<OAuthCompleteResult> {
    await this.evictExpiredStates();
    if (!browserBinding) {
      throw new BadRequestException('OAuth 브라우저 확인 정보가 없습니다. 다시 시도해 주세요.');
    }
    const pending = await this.consumeState(state, provider, browserBinding);
    if (redirectUri && redirectUri !== pending.redirectUri) {
      throw new BadRequestException('OAuth 리디렉션 URI가 일치하지 않습니다.');
    }

    const effectiveRedirect = pending.redirectUri;
    if (provider === 'discord') {
      const profile = await this.exchangeDiscordCode(code, effectiveRedirect);
      return {
        provider,
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
      provider,
      ...profile,
      returnTo: pending.returnTo,
      mode: pending.mode,
      linkAccountId: pending.linkAccountId
      ,agreeTerms: pending.agreeTerms
      ,agreePrivacy: pending.agreePrivacy
    };
  }

  async createPendingSignup(profile: OAuthCompleteResult, ticketHash: string, browserBinding: string): Promise<void> {
    if (profile.mode !== 'login' || !profile.credential) {
      throw new BadRequestException('신규 OAuth 가입 정보를 준비할 수 없습니다.');
    }
    const encrypted = encryptAppSecret(JSON.stringify({
      providerUserId: profile.providerUserId,
      email: profile.email,
      displayName: profile.displayName,
      credential: profile.credential
    }));
    if (!encrypted) throw new InternalServerErrorException('신규 OAuth 가입 정보를 보호할 수 없습니다.');
    const now = new Date();
    await this.prisma.oAuthPendingSignup.create({
      data: {
        id: ticketHash,
        provider: profile.provider,
        payloadEncrypted: encrypted,
        returnTo: profile.returnTo ?? null,
        browserBindingHash: hashOAuthBrowserBinding(browserBinding),
        createdAt: now,
        expiresAt: new Date(now.getTime() + SIGNUP_TTL_MS)
      }
    });
  }

  async consumePendingSignup(token: string, browserBinding: string): Promise<OAuthCompleteResult> {
    const id = hashOAuthSignupTicket(token);
    return this.prisma.$transaction(async (tx) => {
      const pending = await tx.oAuthPendingSignup.findUnique({ where: { id } });
      if (
        !pending ||
        pending.expiresAt.getTime() <= Date.now() ||
        !matchesOAuthBrowserBinding(browserBinding, pending.browserBindingHash)
      ) {
        throw new BadRequestException('신규 가입 확인이 만료되었거나 현재 브라우저와 일치하지 않습니다.');
      }
      const consumed = await tx.oAuthPendingSignup.deleteMany({
        where: { id, expiresAt: { gt: new Date() } }
      });
      if (consumed.count !== 1) {
        throw new BadRequestException('신규 가입 확인이 이미 사용되었거나 만료되었습니다.');
      }
      const decrypted = decryptAppSecret(pending.payloadEncrypted);
      if (!decrypted) throw new BadRequestException('신규 가입 정보를 확인할 수 없습니다.');
      const payload = parsePendingSignupPayload(decrypted);
      return {
        provider: pending.provider,
        providerUserId: payload.providerUserId,
        email: payload.email,
        displayName: payload.displayName,
        returnTo: pending.returnTo ?? undefined,
        mode: 'login',
        agreeTerms: true,
        agreePrivacy: true,
        credential: payload.credential
      };
    });
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

    const tokenResponse = await fetchWithTimeout('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }).catch((error) => {
      this.logger.error({ err: error }, 'Discord 토큰 요청 실패');
      throw new ServiceUnavailableException('Discord OAuth 서비스에 일시적으로 연결할 수 없습니다.');
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

    const userResponse = await fetchWithTimeout('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`
      }
    }).catch((error) => {
      this.logger.error({ err: error }, 'Discord 사용자 정보 요청 실패');
      throw new ServiceUnavailableException('Discord 사용자 정보를 일시적으로 확인할 수 없습니다.');
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
    await withActiveCanonicalAccountGroup(this.prisma, [accountId], async (tx) => {
      await tx.oAuthCredential.upsert({
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

    const tokenResponse = await fetchWithTimeout('https://nid.naver.com/oauth2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }).catch((error) => {
      this.logger.error({ err: error }, 'NAVER 토큰 요청 실패');
      throw new ServiceUnavailableException('NAVER OAuth 서비스에 일시적으로 연결할 수 없습니다.');
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

    const userResponse = await fetchWithTimeout('https://openapi.naver.com/v1/nid/me', {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`
      }
    }).catch((error) => {
      this.logger.error({ err: error }, 'NAVER 사용자 정보 요청 실패');
      throw new ServiceUnavailableException('NAVER 사용자 정보를 일시적으로 확인할 수 없습니다.');
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

  private async consumeState(
    state: string,
    provider: OAuthProvider,
    browserBinding: string
  ): Promise<PendingOAuthState> {
    return this.prisma.$transaction(async (transaction) => {
      const pending = await transaction.oAuthState.findUnique({ where: { state } });
      if (
        !pending ||
        pending.provider !== provider ||
        pending.expiresAt.getTime() <= Date.now() ||
        !pending.browserBindingHash ||
        !matchesOAuthBrowserBinding(browserBinding, pending.browserBindingHash)
      ) {
        throw new BadRequestException('만료되었거나 유효하지 않은 OAuth 상태입니다.');
      }
      const consumed = await transaction.oAuthState.deleteMany({
        where: {
          state,
          provider,
          browserBindingHash: hashOAuthBrowserBinding(browserBinding),
          expiresAt: { gt: new Date() }
        }
      });
      if (consumed.count !== 1) {
        throw new BadRequestException('만료되었거나 이미 사용된 OAuth 상태입니다.');
      }
      return {
        provider: pending.provider,
        redirectUri: pending.redirectUri,
        returnTo: pending.returnTo ?? undefined,
        mode: pending.mode,
        linkAccountId: pending.linkAccountId ?? undefined,
        agreeTerms: pending.agreeTerms,
        agreePrivacy: pending.agreePrivacy,
        createdAt: pending.createdAt,
        expiresAt: pending.expiresAt,
        browserBindingHash: pending.browserBindingHash
      };
    });
  }

  private async evictExpiredStates(): Promise<void> {
    const now = new Date();
    const pendingSignupDelegate = this.prisma.oAuthPendingSignup;
    await Promise.all([
      this.prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: now } } }),
      pendingSignupDelegate?.deleteMany({ where: { expiresAt: { lt: now } } }) ?? Promise.resolve()
    ]);
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

function parsePendingSignupPayload(value: string): {
  readonly providerUserId: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly credential: OAuthCredentialSnapshot;
} {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new BadRequestException('신규 가입 정보를 확인할 수 없습니다.');
  }
  if (!payload || typeof payload !== 'object') throw new BadRequestException('신규 가입 정보를 확인할 수 없습니다.');
  const record = payload as Record<string, unknown>;
  const credential = record.credential;
  if (
    typeof record.providerUserId !== 'string' || !record.providerUserId ||
    !credential || typeof credential !== 'object' ||
    typeof (credential as Record<string, unknown>).accessToken !== 'string'
  ) {
    throw new BadRequestException('신규 가입 정보를 확인할 수 없습니다.');
  }
  const credentialRecord = credential as Record<string, unknown>;
  const expiresAt = typeof credentialRecord.expiresAt === 'string'
    ? new Date(credentialRecord.expiresAt)
    : undefined;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new BadRequestException('신규 가입 정보를 확인할 수 없습니다.');
  }
  return {
    providerUserId: record.providerUserId,
    email: typeof record.email === 'string' ? record.email : undefined,
    displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
    credential: {
      accessToken: credentialRecord.accessToken as string,
      refreshToken: typeof credentialRecord.refreshToken === 'string' ? credentialRecord.refreshToken : undefined,
      tokenType: typeof credentialRecord.tokenType === 'string' ? credentialRecord.tokenType : undefined,
      scope: typeof credentialRecord.scope === 'string' ? credentialRecord.scope : undefined,
      expiresAt
    }
  };
}
