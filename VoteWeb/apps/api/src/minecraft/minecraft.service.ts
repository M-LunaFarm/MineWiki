import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { ConfigService } from '@creepervote/config';
import type {
  MinecraftAuthorizationStartRequest,
  MinecraftAuthorizationStartResponse,
  MinecraftVerificationRequest
} from '@creepervote/schemas';
import { BusinessEventService } from '../events/business-event.service';
import { PrismaService } from '../common/prisma.service';

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

    const redirectUri = request.redirectUri ?? fallbackRedirect;
    if (!redirectUri) {
      throw new InternalServerErrorException('MICROSOFT_REDIRECT_URI is not configured.');
    }

    const state = this.generateState();
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = this.deriveCodeChallenge(codeVerifier);

    const url = new URL('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'XboxLive.signin offline_access');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    await this.evictExpiredAuthorizations();
    await this.prisma.minecraftAuthorization.create({
      data: {
        state,
        accountId: request.userId,
        redirectUri,
        codeVerifier,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + AUTH_STATE_TTL_MS)
      }
    });

    return {
      authorizationUrl: url.toString(),
      state,
      codeVerifier
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
    let effectiveCodeVerifier = payload.codeVerifier;

    if (payload.state) {
      const pending = await this.consumeAuthorization(payload.state, payload.userId);
      if (effectiveRedirect && effectiveRedirect !== pending.redirectUri) {
        throw new ForbiddenException('Redirect URI mismatch for provided state.');
      }
      if (effectiveCodeVerifier && effectiveCodeVerifier !== pending.codeVerifier) {
        throw new ForbiddenException('Code verifier mismatch for provided state.');
      }
      effectiveRedirect = pending.redirectUri;
      effectiveCodeVerifier = pending.codeVerifier;
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
      lastVerifiedAt: new Date().toISOString()
    };

    await this.prisma.minecraftIdentity.upsert({
      where: { accountId: payload.userId },
      update: {
        uuid: identity.uuid,
        playerName: identity.playerName ?? null,
        msOwned: identity.msOwned,
        lastVerifiedAt: new Date(identity.lastVerifiedAt)
      },
      create: {
        accountId: payload.userId,
        uuid: identity.uuid,
        playerName: identity.playerName ?? null,
        msOwned: identity.msOwned,
        lastVerifiedAt: new Date(identity.lastVerifiedAt)
      }
    });

    this.logger.log(`Minecraft ownership verified for user ${payload.userId}`);

    return identity;
  }

  async getIdentity(userId: string): Promise<MinecraftIdentity> {
    const identity = await this.prisma.minecraftIdentity.findUnique({
      where: { accountId: userId }
    });
    if (!identity) {
      throw new NotFoundException('Minecraft ownership verification not found for user');
    }
    let playerName = identity.playerName ?? undefined;
    if (!playerName) {
      playerName = await this.resolvePlayerName(identity.uuid);
      if (playerName) {
        await this.prisma.minecraftIdentity
          .update({
            where: { accountId: userId },
            data: { playerName }
          })
          .catch(() => undefined);
      }
    }
    return {
      uuid: identity.uuid,
      playerName,
      msOwned: identity.msOwned,
      lastVerifiedAt: identity.lastVerifiedAt.toISOString()
    };
  }

  async revokeIdentity(userId: string): Promise<void> {
    const [removedIdentity] = await this.prisma.$transaction([
      this.prisma.minecraftIdentity.deleteMany({
        where: { accountId: userId }
      }),
      this.prisma.minecraftAuthorization.deleteMany({
        where: { accountId: userId }
      })
    ]);

    await this.events.track('minecraft.verification.revoked', {
      userId,
      removed: removedIdentity.count > 0
    });
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

    const form = new URLSearchParams({
      client_id: clientId,
      scope: 'XboxLive.signin offline_access',
      code,
      redirect_uri: effectiveRedirect,
      grant_type: 'authorization_code'
    });

    if (clientSecret) {
      form.set('client_secret', clientSecret);
    }
    if (codeVerifier) {
      form.set('code_verifier', codeVerifier);
    }

    const response = await this.safeFetch(
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

    if (!response.ok) {
      const body = await response.text();
      this.logger.warn({ status: response.status, body }, 'Microsoft token exchange failed');
      if (response.status === 403) {
        throw new ServiceUnavailableException(
          'Verification temporarily unavailable. Please try again later.'
        );
      }
      throw new ForbiddenException('Microsoft ?몄쬆 肄붾뱶媛 ?좏슚?섏? ?딆뒿?덈떎.');
    }

    const data: {
      readonly access_token?: string;
    } = await response.json();

    if (!data.access_token) {
      this.logger.error('Microsoft token exchange succeeded without access_token');
      throw new ForbiddenException('Microsoft ?몄쬆 肄붾뱶媛 ?좏슚?섏? ?딆뒿?덈떎.');
    }

    return data.access_token;
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
      const body = await response.text();
      this.logger.warn({ status: response.status, body }, 'Xbox Live authentication failed');
      if (response.status === 403) {
        throw new ServiceUnavailableException(
          'Verification temporarily unavailable. Please try again later.'
        );
      }
      throw new ForbiddenException('Xbox Live ?몄쬆???ㅽ뙣?덉뒿?덈떎.');
    }

    const data: XboxAuthResponse = await response.json();
    const token = data.Token;
    const userHash = data.DisplayClaims?.xui?.[0]?.uhs;

    if (!token || !userHash) {
      this.logger.error({ data }, 'Xbox Live response missing token or user hash');
      throw new ForbiddenException('Xbox Live ?몄쬆???ㅽ뙣?덉뒿?덈떎.');
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
      const body = await response.text();
      this.logger.warn({ status: response.status, body }, 'XSTS authorization failed');
      if (response.status === 403) {
        throw new ServiceUnavailableException(
          'Verification temporarily unavailable. Please try again later.'
        );
      }
      throw new ForbiddenException('XSTS ?좏겙 諛쒓툒???ㅽ뙣?덉뒿?덈떎.');
    }

    const data: XboxAuthResponse = await response.json();
    const token = data.Token;
    const nextUserHash = data.DisplayClaims?.xui?.[0]?.uhs ?? userHash;

    if (!token || !nextUserHash) {
      this.logger.error({ data }, 'XSTS response missing token or user hash');
      throw new ForbiddenException('XSTS ?좏겙 諛쒓툒???ㅽ뙣?덉뒿?덈떎.');
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
      const body = await response.text();
      this.logger.warn({ status: response.status, body }, 'Minecraft login failed');
      if (response.status === 403) {
        throw new ServiceUnavailableException(
          'Verification temporarily unavailable. Please try again later.'
        );
      }
      throw new ForbiddenException('Minecraft ?쒕퉬???몄쬆???ㅽ뙣?덉뒿?덈떎.');
    }

    const data: MinecraftLoginResponse = await response.json();
    if (!data.access_token) {
      this.logger.error({ data }, 'Minecraft login response missing access_token');
      throw new ForbiddenException('Minecraft ?쒕퉬???몄쬆???ㅽ뙣?덉뒿?덈떎.');
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
      const body = await response.text();
      this.logger.warn({ status: response.status, body }, 'Entitlement lookup failed');
      if (response.status === 403) {
        throw new ServiceUnavailableException(
          'Verification temporarily unavailable. Please try again later.'
        );
      }
      throw new ForbiddenException('Minecraft ?뚯쑀 ?뺤씤???ㅽ뙣?덉뒿?덈떎.');
    }

    const data: EntitlementResponse = await response.json();
    const hasMinecraft = data.items?.some((item) => item.name === 'game_minecraft') ?? false;
    if (!hasMinecraft) {
      throw new ForbiddenException('Minecraft ?뚯쑀媛 ?뺤씤?섏? ?딆븯?듬땲??');
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
      const body = await response.text();
      this.logger.warn({ status: response.status, body }, 'Minecraft profile lookup failed');
      if (response.status === 403) {
        throw new ServiceUnavailableException(
          'Verification temporarily unavailable. Please try again later.'
        );
      }
      throw new ForbiddenException('Minecraft ?꾨줈??議고쉶???ㅽ뙣?덉뒿?덈떎.');
    }

    const data: MinecraftProfileResponse = await response.json();
    const rawId = data.id;
    if (!rawId) {
      this.logger.error({ data }, 'Minecraft profile response missing id');
      throw new ForbiddenException('Minecraft ?꾨줈??議고쉶???ㅽ뙣?덉뒿?덈떎.');
    }
    const playerName = typeof data.name === 'string' ? data.name : undefined;
    return { uuid: this.formatUuid(rawId), playerName };
  }

  private formatUuid(raw: string): string {
    const normalized = raw.replace(/-/g, '').trim();
    if (normalized.length !== 32) {
      throw new ForbiddenException('Minecraft ?꾨줈??UUID ?뺤떇???щ컮瑜댁? ?딆뒿?덈떎.');
    }
    return [
      normalized.slice(0, 8),
      normalized.slice(8, 12),
      normalized.slice(12, 16),
      normalized.slice(16, 20),
      normalized.slice(20)
    ].join('-');
  }

  private async consumeAuthorization(state: string, userId: string) {
    await this.evictExpiredAuthorizations();
    const pending = await this.prisma.minecraftAuthorization.findUnique({
      where: { state }
    });
    if (!pending) {
      throw new ForbiddenException('留뚮즺?섏뿀嫄곕굹 ?좏슚?섏? ?딆? ?몄쬆 ?곹깭?낅땲??');
    }
    if (pending.accountId !== userId) {
      throw new ForbiddenException('?몄쬆 ?곹깭媛 ?ㅻⅨ ?ъ슜?먯? ?곌껐?섏뼱 ?덉뒿?덈떎.');
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
      return await fetch(input, init);
    } catch (error) {
      this.logger.error({ err: error }, `${context} network error`);
      throw new ServiceUnavailableException(
        'Verification temporarily unavailable. Please try again later.'
      );
    }
  }
}
