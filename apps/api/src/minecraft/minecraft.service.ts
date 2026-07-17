import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { ConfigService } from '@minewiki/config';
import { normalizeMinecraftUuid } from '@minewiki/minecraft';
import type {
  MinecraftAuthorizationStartRequest,
  MinecraftAuthorizationStartResponse,
  MinecraftVerificationRequest
} from '@minewiki/schemas';
import { BusinessEventService } from '../events/business-event.service';
import { PrismaService } from '../common/prisma.service';
import { Prisma } from '@prisma/client';
import { fetchWithTimeout } from '../common/http/external-fetch';
import { withActiveCanonicalAccountGroup } from '../auth/account-lifecycle-fence';

const MICROSOFT_TOKEN_URL =
  'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL =
  'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_ENTITLEMENT_URL =
  'https://api.minecraftservices.com/entitlements/mcstore';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

const AUTH_STATE_TTL_MS = 1000 * 60 * 10; // 10 minutes

export interface MinecraftIdentity {
  readonly uuid: string;
  readonly playerName?: string;
  readonly msOwned: boolean;
  readonly isPrimary: boolean;
  readonly lastVerifiedAt: string;
}

interface XboxAuthResponse {
  readonly Token: string;
  readonly DisplayClaims?: {
    readonly xui?: Array<{
      readonly uhs?: string;
    }>;
  };
}

interface MinecraftLoginResponse {
  readonly access_token?: string;
}

interface EntitlementResponse {
  readonly items?: Array<{
    readonly name?: string;
  }>;
}

interface MinecraftProfileResponse {
  readonly id?: string;
  readonly name?: string;
}

@Injectable()
export class MinecraftService {
  private readonly logger = new Logger(MinecraftService.name);

  constructor(
    private readonly events: BusinessEventService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService
  ) {}

  async startAuthorization(
    request: MinecraftAuthorizationStartRequest
  ): Promise<MinecraftAuthorizationStartResponse> {
    const clientId = this.config.getOptional('MICROSOFT_CLIENT_ID');
    const fallbackRedirect = this.config.getOptional('MICROSOFT_REDIRECT_URI');
    if (!clientId) {
      throw new InternalServerErrorException('MICROSOFT_CLIENT_ID is not configured.');
    }

    if (!fallbackRedirect) {
      throw new InternalServerErrorException('MICROSOFT_REDIRECT_URI is not configured.');
    }
    if (request.redirectUri && request.redirectUri !== fallbackRedirect) {
      throw new ForbiddenException('허용되지 않은 Microsoft 인증 콜백 주소입니다.');
    }
    const redirectUri = fallbackRedirect;

    const state = this.generateState();
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = this.deriveCodeChallenge(codeVerifier);

    const url = new URL('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'XboxLive.signin');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    await this.evictExpiredAuthorizations();
    await withActiveCanonicalAccountGroup(this.prisma, [request.userId], (tx) =>
      tx.minecraftAuthorization.create({
        data: {
          state,
          accountId: request.userId,
          redirectUri,
          codeVerifier,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + AUTH_STATE_TTL_MS)
        }
      })
    );

    return {
      authorizationUrl: url.toString(),
      state
    };
  }

  async verifyOwnership(payload: MinecraftVerificationRequest): Promise<MinecraftIdentity> {
    try {
      const identity = await this.performOwnershipVerification(payload);
      await this.events.track('minecraft.verification.completed', {
        userId: payload.userId,
        uuid: identity.uuid
      });
      return identity;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown_error';
      await this.events.track('minecraft.verification.failed', {
        userId: payload.userId,
        reason
      });
      throw error;
    }
  }

  private async performOwnershipVerification(
    payload: MinecraftVerificationRequest
  ): Promise<MinecraftIdentity> {
    let effectiveRedirect = payload.redirectUri;
    let effectiveCodeVerifier: string | undefined;

    if (payload.state) {
      const pending = await this.consumeAuthorization(payload.state, payload.userId);
      if (effectiveRedirect && effectiveRedirect !== pending.redirectUri) {
        throw new ForbiddenException('Redirect URI mismatch for provided state.');
      }
      effectiveRedirect = pending.redirectUri;
      effectiveCodeVerifier = pending.codeVerifier;
    } else {
      throw new ForbiddenException('Microsoft 인증 상태가 누락되었거나 만료되었습니다.');
    }

    let microsoftToken = await this.exchangeAuthorizationCode(
      payload.authorizationCode,
      effectiveRedirect,
      effectiveCodeVerifier
    );
    let xblToken = '';
    let xblUserHash = '';
    ({ token: xblToken, userHash: xblUserHash } = await this.authenticateWithXboxLive(
      microsoftToken
    ));
    let xstsToken = '';
    let userHash = '';
    ({ token: xstsToken, userHash } = await this.authorizeWithXsts(xblToken, xblUserHash));
    let minecraftAccessToken = await this.loginWithXbox(userHash, xstsToken);

    await this.confirmMinecraftOwnership(minecraftAccessToken);
    const profile = await this.fetchMinecraftProfile(minecraftAccessToken);

    microsoftToken = '';
    xblToken = '';
    xstsToken = '';
    minecraftAccessToken = '';
    xblUserHash = '';
    userHash = '';

    const identity: MinecraftIdentity = {
      uuid: profile.uuid,
      playerName: profile.playerName,
      msOwned: true,
      isPrimary: false,
      lastVerifiedAt: new Date().toISOString()
    };
    let storedIsPrimary = false;

    try {
      await withActiveCanonicalAccountGroup(this.prisma, [payload.userId], async (tx, group) => {
        const clusterAccountIds = [...group.accountIds];
        const existingIdentity = await tx.minecraftIdentity.findFirst({
          where: { uuid: identity.uuid },
          select: { id: true, accountId: true, isPrimary: true },
        });
        if (existingIdentity && !clusterAccountIds.includes(existingIdentity.accountId)) {
          throw new ConflictException('Minecraft identity is already linked to another MineWiki account.');
        }
        const identityCount = await tx.minecraftIdentity.count({
          where: { accountId: { in: clusterAccountIds } },
        });
        const isPrimary = existingIdentity?.isPrimary ?? identityCount === 0;
        if (existingIdentity) {
          await tx.minecraftIdentity.update({
            where: { id: existingIdentity.id },
            data: {
              accountId: payload.userId,
              playerName: identity.playerName ?? null,
              msOwned: identity.msOwned,
              isPrimary,
              lastVerifiedAt: new Date(identity.lastVerifiedAt)
            }
          });
        } else {
          await tx.minecraftIdentity.create({
            data: {
              accountId: payload.userId,
              uuid: identity.uuid,
              playerName: identity.playerName ?? null,
              msOwned: identity.msOwned,
              isPrimary,
              lastVerifiedAt: new Date(identity.lastVerifiedAt)
            }
          });
        }
        storedIsPrimary = isPrimary;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(
          'Minecraft identity is already linked to another MineWiki account.'
        );
      }
      throw error;
    }

    this.logger.log(`Minecraft ownership verified for user ${payload.userId}`);

    return { ...identity, isPrimary: storedIsPrimary };
  }

  async getIdentity(userId: string): Promise<MinecraftIdentity> {
    const identity = await this.findCanonicalIdentity(userId);
    let playerName = identity.playerName ?? undefined;
    if (!playerName) {
      playerName = await this.resolvePlayerName(identity.uuid);
      if (playerName) {
        await this.prisma.minecraftIdentity
          .update({
            where: { id: identity.id },
            data: { playerName }
          })
          .catch(() => undefined);
      }
    }
    return {
      uuid: identity.uuid,
      playerName,
      msOwned: identity.msOwned,
      isPrimary: identity.isPrimary,
      lastVerifiedAt: identity.lastVerifiedAt.toISOString()
    };
  }

  async getIdentities(userId: string): Promise<MinecraftIdentity[]> {
    const clusterAccountIds = await this.resolveCanonicalAccountIds(userId);
    const identities = await this.prisma.minecraftIdentity.findMany({
      where: { accountId: { in: clusterAccountIds } },
      orderBy: [{ isPrimary: 'desc' }, { lastVerifiedAt: 'desc' }, { id: 'asc' }],
    });
    return Promise.all(identities.map(async (identity) => {
      let playerName = identity.playerName ?? undefined;
      if (!playerName) {
        playerName = await this.resolvePlayerName(identity.uuid);
        if (playerName) {
          await this.prisma.minecraftIdentity.update({
            where: { id: identity.id },
            data: { playerName },
          }).catch(() => undefined);
        }
      }
      return {
        uuid: identity.uuid,
        playerName,
        msOwned: identity.msOwned,
        isPrimary: identity.isPrimary,
        lastVerifiedAt: identity.lastVerifiedAt.toISOString(),
      };
    }));
  }

  async getStoredIdentity(userId: string): Promise<MinecraftIdentity> {
    const identity = await this.findCanonicalIdentity(userId);
    return {
      uuid: identity.uuid,
      playerName: identity.playerName ?? undefined,
      msOwned: identity.msOwned,
      isPrimary: identity.isPrimary,
      lastVerifiedAt: identity.lastVerifiedAt.toISOString()
    };
  }

  async setPrimaryIdentity(userId: string, minecraftUuid: string): Promise<MinecraftIdentity> {
    const normalizedUuid = normalizeMinecraftUuid(minecraftUuid);
    let selected: {
      uuid: string;
      playerName: string | null;
      msOwned: boolean;
      lastVerifiedAt: Date;
    } | null = null;
    await withActiveCanonicalAccountGroup(this.prisma, [userId], async (tx, group) => {
      const identity = await tx.minecraftIdentity.findFirst({
        where: { uuid: normalizedUuid, accountId: { in: [...group.accountIds] } },
        select: { id: true, uuid: true, playerName: true, msOwned: true, lastVerifiedAt: true },
      });
      if (!identity) {
        throw new NotFoundException('Minecraft ownership verification not found for user');
      }
      await tx.minecraftIdentity.updateMany({
        where: { accountId: { in: [...group.accountIds] }, isPrimary: true },
        data: { isPrimary: false },
      });
      await tx.minecraftIdentity.update({
        where: { id: identity.id },
        data: { isPrimary: true },
      });
      selected = identity;
    });
    const identity = selected!;
    await this.events.track('minecraft.verification.primary_changed', {
      userId,
      uuid: identity.uuid,
    });
    return {
      uuid: identity.uuid,
      playerName: identity.playerName ?? undefined,
      msOwned: identity.msOwned,
      isPrimary: true,
      lastVerifiedAt: identity.lastVerifiedAt.toISOString(),
    };
  }

  async revokeIdentity(userId: string, minecraftUuid?: string): Promise<void> {
    const clusterAccountIds = await this.resolveCanonicalAccountIds(userId);
    const removedIdentity = await this.prisma.$transaction(async (tx) => {
      const selected = minecraftUuid
        ? await tx.minecraftIdentity.findFirst({
            where: { uuid: normalizeMinecraftUuid(minecraftUuid), accountId: { in: clusterAccountIds } },
          })
        : null;
      const removed = await tx.minecraftIdentity.deleteMany({
        where: minecraftUuid
          ? { uuid: normalizeMinecraftUuid(minecraftUuid), accountId: { in: clusterAccountIds } }
          : { accountId: { in: clusterAccountIds } },
      });
      if (selected?.isPrimary) {
        const replacement = await tx.minecraftIdentity.findFirst({
          where: { accountId: { in: clusterAccountIds } },
          orderBy: [{ lastVerifiedAt: 'desc' }, { id: 'asc' }],
        });
        if (replacement) {
          await tx.minecraftIdentity.update({ where: { id: replacement.id }, data: { isPrimary: true } });
        }
      }
      await tx.minecraftAuthorization.deleteMany({ where: { accountId: { in: clusterAccountIds } } });
      return removed;
    });

    await this.events.track('minecraft.verification.revoked', {
      userId,
      removed: removedIdentity.count > 0
    });
  }

  private async findCanonicalIdentity(userId: string) {
    const clusterAccountIds = await this.resolveCanonicalAccountIds(userId);
    const identities = await this.prisma.minecraftIdentity.findMany({
      where: { accountId: { in: clusterAccountIds } },
      orderBy: [{ isPrimary: 'desc' }, { lastVerifiedAt: 'desc' }, { id: 'asc' }],
      take: 1
    });
    if (identities.length === 0) {
      throw new NotFoundException('Minecraft ownership verification not found for user');
    }
    return identities[0]!;
  }

  private async resolveCanonicalAccountIds(userId: string): Promise<string[]> {
    const seed = await this.prisma.account.findUnique({
      where: { id: userId },
      select: { id: true, canonicalAccountId: true }
    });
    const canonicalAccountId = seed?.canonicalAccountId ?? seed?.id ?? userId;
    const accounts = await this.prisma.account.findMany({
      where: {
        OR: [{ id: canonicalAccountId }, { canonicalAccountId }]
      },
      select: { id: true }
    });
    const ids = accounts.map((account) => account.id);
    return ids.includes(canonicalAccountId) ? ids : [canonicalAccountId, ...ids];
  }

  private async exchangeAuthorizationCode(
    code: string,
    redirectUri?: string,
    codeVerifier?: string
  ): Promise<string> {
    const clientId = this.config.getOptional('MICROSOFT_CLIENT_ID');
    const clientSecret = this.config.getOptional('MICROSOFT_CLIENT_SECRET');
    const fallbackRedirect = this.config.getOptional('MICROSOFT_REDIRECT_URI');

    if (!clientId) {
      throw new InternalServerErrorException('MICROSOFT_CLIENT_ID is not configured.');
    }

    const effectiveRedirect = redirectUri ?? fallbackRedirect;
    if (!effectiveRedirect) {
      throw new InternalServerErrorException('MICROSOFT_REDIRECT_URI is not configured.');
    }

    const requestToken = (includeClientSecret: boolean) => {
      const form = new URLSearchParams({
        client_id: clientId,
        scope: 'XboxLive.signin',
        code,
        redirect_uri: effectiveRedirect,
        grant_type: 'authorization_code'
      });
      if (includeClientSecret && clientSecret) {
        form.set('client_secret', clientSecret);
      }
      if (codeVerifier) {
        form.set('code_verifier', codeVerifier);
      }
      return this.safeFetch(
        MICROSOFT_TOKEN_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: form
        },
        'Microsoft token exchange'
      );
    };

    let response = await requestToken(Boolean(clientSecret));
    if (response.status === 401 && clientSecret && codeVerifier) {
      const oauthError = await this.readMicrosoftOAuthError(response);
      this.logger.warn(
        { status: response.status, oauthError: oauthError.error, aadsts: oauthError.aadsts },
        'Microsoft confidential token exchange rejected; retrying the PKCE public-client flow'
      );
      response = await requestToken(false);
    }

    if (!response.ok) {
      const oauthError = await this.readMicrosoftOAuthError(response);
      this.logger.warn(
        { status: response.status, oauthError: oauthError.error, aadsts: oauthError.aadsts },
        'Microsoft token exchange failed'
      );
      if (response.status === 403) {
        throw new ServiceUnavailableException(
          'Verification temporarily unavailable. Please try again later.'
        );
      }
      throw new ForbiddenException('Microsoft 인증 코드가 유효하지 않습니다.');
    }

    const data: {
      readonly access_token?: string;
    } = await response.json();

    if (!data.access_token) {
      this.logger.error('Microsoft token exchange succeeded without access_token');
      throw new ForbiddenException('Microsoft 인증 코드가 유효하지 않습니다.');
    }

    return data.access_token;
  }

  private async readMicrosoftOAuthError(response: Response): Promise<{
    readonly error?: string;
    readonly aadsts?: string;
  }> {
    const payload = (await response.json().catch(() => ({}))) as {
      readonly error?: unknown;
      readonly error_description?: unknown;
    };
    const description = typeof payload.error_description === 'string'
      ? payload.error_description
      : '';
    return {
      error: typeof payload.error === 'string' ? payload.error.slice(0, 80) : undefined,
      aadsts: description.match(/AADSTS\d+/u)?.[0]
    };
  }

  private async authenticateWithXboxLive(accessToken: string): Promise<{
    token: string;
    userHash: string;
  }> {
    const payload = {
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${accessToken}`
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    };

    const response = await this.safeFetch(
      XBL_AUTH_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      'Xbox Live authentication'
    );

    if (!response.ok) {
      this.logger.warn({ status: response.status }, 'Xbox Live authentication failed');
      if (response.status === 403) {
        throw new ServiceUnavailableException(
          'Verification temporarily unavailable. Please try again later.'
        );
      }
      throw new ForbiddenException('Xbox Live 인증에 실패했습니다.');
    }

    const data: XboxAuthResponse = await response.json();
    const token = data.Token;
    const userHash = data.DisplayClaims?.xui?.[0]?.uhs;

    if (!token || !userHash) {
      this.logger.error('Xbox Live response missing token or user hash');
      throw new ForbiddenException('Xbox Live 인증에 실패했습니다.');
    }

    return { token, userHash };
  }

  private async authorizeWithXsts(
    xblToken: string,
    userHash: string
  ): Promise<{ token: string; userHash: string }> {
    const payload = {
      Properties: {
        SandboxId: 'RETAIL',
        UserTokens: [xblToken]
      },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    };

    const response = await this.safeFetch(
      XSTS_AUTH_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      'XSTS authorization'
    );

    if (!response.ok) {
      this.logger.warn({ status: response.status }, 'XSTS authorization failed');
      if (response.status === 403) {
        throw new ServiceUnavailableException(
          'Verification temporarily unavailable. Please try again later.'
        );
      }
      throw new ForbiddenException('XSTS 토큰 발급에 실패했습니다.');
    }

    const data: XboxAuthResponse = await response.json();
    const token = data.Token;
    const nextUserHash = data.DisplayClaims?.xui?.[0]?.uhs ?? userHash;

    if (!token || !nextUserHash) {
      this.logger.error('XSTS response missing token or user hash');
      throw new ForbiddenException('XSTS 토큰 발급에 실패했습니다.');
    }

    return { token, userHash: nextUserHash };
  }

  private async loginWithXbox(userHash: string, xstsToken: string): Promise<string> {
    const payload = {
      identityToken: `XBL3.0 x=${userHash};${xstsToken}`,
      ensureLegacyEnabled: true
    };

    const response = await this.safeFetch(
      MC_LOGIN_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      },
      'Minecraft login_with_xbox'
    );

    if (!response.ok) {
      this.logger.warn({ status: response.status }, 'Minecraft login failed');
      if (response.status === 403) {
        throw new ServiceUnavailableException(
          'Verification temporarily unavailable. Please try again later.'
        );
      }
      throw new ForbiddenException('Minecraft 서비스 인증에 실패했습니다.');
    }

    const data: MinecraftLoginResponse = await response.json();
    if (!data.access_token) {
      this.logger.error('Minecraft login response missing access_token');
      throw new ForbiddenException('Minecraft 서비스 인증에 실패했습니다.');
    }
    return data.access_token;
  }

  private async confirmMinecraftOwnership(accessToken: string): Promise<void> {
    const response = await this.safeFetch(
      MC_ENTITLEMENT_URL,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      },
      'Minecraft entitlement lookup'
    );

    if (!response.ok) {
      this.logger.warn({ status: response.status }, 'Entitlement lookup failed');
      if (response.status === 403) {
        throw new ServiceUnavailableException(
          'Verification temporarily unavailable. Please try again later.'
        );
      }
      throw new ForbiddenException('Minecraft 소유 확인에 실패했습니다.');
    }

    const data: EntitlementResponse = await response.json();
    const hasMinecraft = data.items?.some((item) => item.name === 'game_minecraft') ?? false;
    if (!hasMinecraft) {
      throw new ForbiddenException('Minecraft 소유가 확인되지 않았습니다.');
    }
  }

  private async fetchMinecraftProfile(accessToken: string): Promise<{ uuid: string; playerName?: string }> {
    const response = await this.safeFetch(
      MC_PROFILE_URL,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      },
      'Minecraft profile lookup'
    );

    if (!response.ok) {
      this.logger.warn({ status: response.status }, 'Minecraft profile lookup failed');
      if (response.status === 403) {
        throw new ServiceUnavailableException(
          'Verification temporarily unavailable. Please try again later.'
        );
      }
      throw new ForbiddenException('Minecraft 프로필 조회에 실패했습니다.');
    }

    const data: MinecraftProfileResponse = await response.json();
    const rawId = data.id;
    if (!rawId) {
      this.logger.error('Minecraft profile response missing id');
      throw new ForbiddenException('Minecraft 프로필 조회에 실패했습니다.');
    }
    const playerName = typeof data.name === 'string' ? data.name : undefined;
    return { uuid: this.formatUuid(rawId), playerName };
  }

  private formatUuid(raw: string): string {
    try {
      return normalizeMinecraftUuid(raw);
    } catch {
      throw new ForbiddenException('Minecraft 프로필 UUID 형식이 올바르지 않습니다.');
    }
  }

  private async consumeAuthorization(state: string, userId: string) {
    await this.evictExpiredAuthorizations();
    const pending = await this.prisma.minecraftAuthorization.findUnique({
      where: { state }
    });
    if (!pending) {
      throw new ForbiddenException('만료되었거나 유효하지 않은 인증 상태입니다.');
    }
    if (pending.accountId !== userId) {
      throw new ForbiddenException('인증 상태가 다른 사용자와 연결되어 있습니다.');
    }
    await this.prisma.minecraftAuthorization.delete({ where: { state } });
    return pending;
  }

  private async evictExpiredAuthorizations(): Promise<void> {
    await this.prisma.minecraftAuthorization.deleteMany({
      where: { expiresAt: { lt: new Date() } }
    });
  }

  private async resolvePlayerName(uuid: string): Promise<string | undefined> {
    const compactUuid = uuid.replace(/-/g, '').trim();
    if (compactUuid.length !== 32) {
      return undefined;
    }
    const response = await this.safeFetch(
      `https://sessionserver.mojang.com/session/minecraft/profile/${compactUuid}`,
      { method: 'GET' },
      'Minecraft profile lookup'
    );
    if (!response.ok) {
      return undefined;
    }
    const data = (await response.json().catch(() => ({}))) as { name?: string };
    return typeof data?.name === 'string' ? data.name : undefined;
  }

  private generateState(): string {
    return this.toBase64Url(randomBytes(24));
  }

  private generateCodeVerifier(): string {
    const buffer = randomBytes(64);
    const verifier = this.toBase64Url(buffer);
    if (verifier.length < 43) {
      return (verifier + this.toBase64Url(randomBytes(8))).slice(0, 64);
    }
    return verifier.slice(0, Math.min(verifier.length, 96));
  }

  private deriveCodeChallenge(codeVerifier: string): string {
    const digest = createHash('sha256').update(codeVerifier).digest();
    return this.toBase64Url(digest);
  }

  private toBase64Url(buffer: Buffer): string {
    return buffer
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');
  }

  private async safeFetch(
    input: string,
    init: RequestInit,
    context: string
  ): Promise<Response> {
    try {
      return await fetchWithTimeout(input, init);
    } catch (error) {
      this.logger.error({ err: error }, `${context} network error`);
      throw new ServiceUnavailableException(
        'Verification temporarily unavailable. Please try again later.'
      );
    }
  }
}
