import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { ServerService } from '../server/server.service';
import type {
  ClaimMethod,
  ClaimMethodState,
  ClaimMethodStatus,
  ClaimStatusResponse,
} from './claim.types';
import { PrismaService } from '../common/prisma.service';
import { validateOutboundTarget } from '@minewiki/security';
import { status, statusBedrock } from 'minecraft-server-util';
import { encryptAppSecret } from '../common/secret-codec';

export interface ClaimVerificationResult {
  readonly status: ClaimMethodState;
  readonly checkedAt: string;
  readonly note?: string;
}

const ALL_METHODS: ClaimMethod[] = ['dns', 'motd'];
const METHOD_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h
type StoredVerificationGrade = 'A' | 'B' | 'C' | 'Unverified';

@Injectable()
export class ClaimService {
  private readonly logger = new Logger(ClaimService.name);

  constructor(
    @Inject(forwardRef(() => ServerService)) private readonly serverService: ServerService,
    private readonly prisma: PrismaService,
  ) {}

  async issueTokens(
    serverId: string,
    accountId: string,
    methods?: ClaimMethod[],
  ): Promise<ClaimMethodStatus[]> {
    const server = await this.serverService.ensureExists(serverId);
    if (server.ownerAccountId && server.ownerAccountId !== accountId) {
      throw new ForbiddenException('해당 서버를 검증할 권한이 없습니다.');
    }
    if (
      !server.ownerAccountId &&
      server.registrantAccountId &&
      server.registrantAccountId !== accountId
    ) {
      throw new ForbiddenException('서버를 등록한 계정만 최초 소유권 검증을 시작할 수 있습니다.');
    }
    const targets = methods && methods.length > 0 ? methods : ALL_METHODS;
    if (targets.includes('plugin')) {
      throw new BadRequestException(
        'Plugin ownership verification is unavailable until an authenticated plugin proof is configured.',
      );
    }
    const issuedTokens = new Map(targets.map((method) => [method, generateToken()]));

    const now = new Date();
    const updates = await this.prisma.$transaction(
      targets.map((method) =>
        this.prisma.serverClaimMethod.upsert({
          where: {
            serverId_method: {
              serverId,
              method,
            },
          },
          create: {
            serverId,
            accountId,
            method,
            token: hashClaimToken(issuedTokens.get(method)!),
            tokenCiphertext: encryptAppSecret(issuedTokens.get(method)!),
            issuedAt: now,
            status: 'pending',
            lastCheckedAt: now,
            note: 'token_issued',
          },
          update: {
            accountId,
            token: hashClaimToken(issuedTokens.get(method)!),
            tokenCiphertext: encryptAppSecret(issuedTokens.get(method)!),
            issuedAt: now,
            status: 'pending',
            verifiedAt: null,
            lastCheckedAt: now,
            note: 'token_issued',
          },
        }),
      ),
    );

    await this.syncGrade(serverId);
    return updates.map((method) =>
      this.serializeMethod(method, issuedTokens.get(method.method as ClaimMethod)),
    );
  }

  async verifyMethod(
    serverId: string,
    method: ClaimMethod,
    proof: string,
    accountId: string,
  ): Promise<ClaimStatusResponse> {
    const server = await this.serverService.ensureExists(serverId);
    await this.expireMethodsIfNeeded(serverId);

    const methodState = await this.prisma.serverClaimMethod.findUnique({
      where: {
        serverId_method: {
          serverId,
          method,
        },
      },
    });

    if (!methodState) {
      throw new BadRequestException('검증 토큰을 먼저 발급해주세요.');
    }
    if (methodState.status === 'expired') {
      throw new BadRequestException('검증 토큰이 만료되었습니다. 토큰을 다시 발급받아 주세요.');
    }

    this.assertCanUseClaimMethod(server.ownerAccountId, methodState.accountId, accountId);

    const normalizedProof = proof?.trim();
    if (!normalizedProof || !matchesClaimToken(methodState.token, normalizedProof)) {
      throw new BadRequestException('검증 토큰이 일치하지 않습니다. 토큰을 다시 발급받아 주세요.');
    }

    const result = await this.runVerificationCheck(method, normalizedProof, serverId);
    await this.applyVerificationResult(serverId, method, result);
    return this.getStatus(serverId);
  }

  async applyVerificationResult(
    serverId: string,
    method: ClaimMethod,
    result: ClaimVerificationResult,
  ): Promise<ClaimStatusResponse> {
    await this.serverService.ensureExists(serverId);
    const checkedAt = new Date(result.checkedAt);

    const updatedMethod = await this.prisma.serverClaimMethod.update({
      where: {
        serverId_method: {
          serverId,
          method,
        },
      },
      data: {
        status: result.status,
        lastCheckedAt: checkedAt,
        note: result.note ?? null,
        verifiedAt: result.status === 'verified' ? checkedAt : null,
      },
    });

    if (result.status === 'verified' && updatedMethod.accountId) {
      await this.prisma.server.updateMany({
        where: {
          id: serverId,
          ownerAccountId: null,
        },
        data: {
          ownerAccountId: updatedMethod.accountId,
          registrantAccountId: null,
        },
      });
    }

    await this.syncGrade(serverId);
    return this.getStatus(serverId);
  }

  async getStatus(serverId: string): Promise<ClaimStatusResponse> {
    await this.serverService.ensureExists(serverId);
    await this.expireMethodsIfNeeded(serverId);

    const [server, methods] = await Promise.all([
      this.serverService.ensureExists(serverId),
      this.prisma.serverClaimMethod.findMany({
        where: { serverId },
      }),
    ]);
    const supportedMethods = methods.filter((method) => isSupportedClaimMethod(method.method));
    await this.syncStoredGradeFromMethods(
      serverId,
      server.verificationGrade as StoredVerificationGrade,
      supportedMethods,
    );

    return {
      serverId,
      grade: this.computeVerificationStatus(supportedMethods),
      methods: supportedMethods.map((method) => this.serializeMethod(method)),
    };
  }

  async isOwner(serverId: string, accountId: string): Promise<boolean> {
    const server = await this.serverService.ensureExists(serverId);
    return Boolean(server.ownerAccountId && server.ownerAccountId === accountId);
  }

  async isPendingRegistrant(serverId: string, accountId: string): Promise<boolean> {
    const server = await this.serverService.ensureExists(serverId);
    return Boolean(
      !server.ownerAccountId &&
        server.registrantAccountId &&
        server.registrantAccountId === accountId,
    );
  }

  async canAccessClaim(serverId: string, accountId: string): Promise<boolean> {
    return (
      (await this.isOwner(serverId, accountId)) ||
      (await this.isPendingRegistrant(serverId, accountId))
    );
  }

  private assertCanUseClaimMethod(
    ownerAccountId: string | null,
    issuerAccountId: string | null,
    accountId: string,
  ): void {
    if (ownerAccountId) {
      if (ownerAccountId !== accountId) {
        throw new ForbiddenException('해당 서버를 검증할 권한이 없습니다.');
      }
      return;
    }

    if (!issuerAccountId || issuerAccountId !== accountId) {
      throw new ForbiddenException('검증 토큰을 발급한 계정만 검증을 진행할 수 있습니다.');
    }
  }

  private async expireMethodsIfNeeded(serverId: string): Promise<void> {
    const now = Date.now();
    const methods = await this.prisma.serverClaimMethod.findMany({
      where: { serverId, status: { in: ['pending', 'verified'] } },
    });

    const expired = methods.filter(
      (method) => now - (method.verifiedAt ?? method.issuedAt).getTime() > METHOD_EXPIRY_MS,
    );

    if (expired.length === 0) {
      return;
    }

    await this.prisma.$transaction(
      expired.map((method) =>
        this.prisma.serverClaimMethod.update({
          where: { id: method.id },
          data: {
            status: 'expired',
            verifiedAt: null,
            lastCheckedAt: new Date(),
            note: 'token_expired',
          },
        }),
      ),
    );

    await this.syncGrade(serverId);
  }

  private async syncGrade(serverId: string): Promise<void> {
    const methods = await this.prisma.serverClaimMethod.findMany({
      where: { serverId },
    });
    const grade = this.computeStoredGrade(methods);
    await this.prisma.server.update({
      where: { id: serverId },
      data: {
        verificationGrade: grade,
        verifiedAt: grade === 'Unverified' ? null : new Date(),
      },
    });
  }

  private async syncStoredGradeFromMethods(
    serverId: string,
    currentGrade: StoredVerificationGrade,
    methods: Array<{ method: string; status: ClaimMethodState }>,
  ): Promise<void> {
    const computedGrade = this.computeStoredGrade(methods);
    if (computedGrade === currentGrade) {
      return;
    }

    await this.prisma.server.update({
      where: { id: serverId },
      data: {
        verificationGrade: computedGrade,
        verifiedAt: computedGrade === 'Unverified' ? null : new Date(),
      },
    });
  }

  private async runVerificationCheck(
    method: ClaimMethod,
    token: string,
    serverId: string,
  ): Promise<ClaimVerificationResult> {
    const checkedAt = new Date().toISOString();

    if (method === 'plugin') {
      return {
        status: 'pending',
        checkedAt,
        note: 'plugin_callback_required',
      };
    }

    try {
      if (method === 'dns') {
        const verified = await verifyDnsToken(serverId, token, this.serverService);
        return {
          status: verified ? 'verified' : 'failed',
          checkedAt,
          note: verified ? 'dns_token_confirmed' : 'dns_token_not_found',
        };
      }
      if (method === 'motd') {
        const verified = await verifyMotdToken(serverId, token, this.serverService);
        return {
          status: verified ? 'verified' : 'failed',
          checkedAt,
          note: verified ? 'motd_token_confirmed' : 'motd_token_not_found',
        };
      }
    } catch (error) {
      this.logger.warn({ err: error, method, serverId }, 'Claim verification failed');
      return {
        status: 'failed',
        checkedAt,
        note: error instanceof Error ? error.message : 'verification_failed',
      };
    }

    return {
      status: 'failed',
      checkedAt,
      note: 'unknown_method',
    };
  }

  private serializeMethod(method: {
    id?: string;
    accountId?: string | null;
    method: string;
    token: string;
    issuedAt: Date;
    status: ClaimMethodState;
    verifiedAt: Date | null;
    lastCheckedAt: Date | null;
    note: string | null;
  }, revealedToken?: string): ClaimMethodStatus {
    if (!isSupportedClaimMethod(method.method)) {
      throw new BadRequestException('지원하지 않는 검증 방식입니다.');
    }
    const expiresAt = method.status === 'pending' || method.status === 'verified'
      ? new Date((method.verifiedAt ?? method.issuedAt).getTime() + METHOD_EXPIRY_MS)
      : undefined;
    return {
      method: method.method as ClaimMethod,
      ...(revealedToken ? { token: revealedToken } : {}),
      issuedAt: method.issuedAt.toISOString(),
      status: method.status,
      verified: method.status === 'verified',
      verifiedAt: method.verifiedAt?.toISOString(),
      expiresAt: expiresAt?.toISOString(),
      lastCheckedAt: method.lastCheckedAt?.toISOString(),
      note: method.note ?? undefined,
    };
  }

  private computeStoredGrade(
    methods: Array<{ method: string; status: ClaimMethodState }>,
  ): StoredVerificationGrade {
    return methods.some((method) => method.status === 'verified') ? 'A' : 'Unverified';
  }

  private computeVerificationStatus(
    methods: Array<{ method: string; status: ClaimMethodState }>,
  ): ClaimStatusResponse['grade'] {
    return methods.some((method) => method.status === 'verified') ? 'Verified' : 'Unverified';
  }
}

function generateToken(): string {
  return randomBytes(8).toString('hex');
}

const CLAIM_TOKEN_HASH_PREFIX = 'sha256:';

export function hashClaimToken(token: string): string {
  return `${CLAIM_TOKEN_HASH_PREFIX}${createHash('sha256').update(token).digest('hex')}`;
}

export function matchesClaimToken(storedToken: string, presentedToken: string): boolean {
  const expected = storedToken.startsWith(CLAIM_TOKEN_HASH_PREFIX)
    ? storedToken
    : hashClaimToken(storedToken);
  const actual = hashClaimToken(presentedToken);
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

async function verifyDnsToken(
  serverId: string,
  token: string,
  serverService: ServerService,
): Promise<boolean> {
  const server = await serverService.ensureExists(serverId);
  const host = normalizeHost(server.joinHost);
  const recordNames = [`_cvverify.${host}`, `_minewiki.${host}`, `_claim.${host}`, host];

  for (const name of recordNames) {
    try {
      const records = await resolveTxt(name);
      const flattened = records.flat().map((entry) => entry.trim());
      if (flattened.some((entry) => matchesToken(entry, token))) {
        return true;
      }
    } catch {
      // ignore lookup failures and continue
    }
  }
  return false;
}

async function verifyMotdToken(
  serverId: string,
  token: string,
  serverService: ServerService,
): Promise<boolean> {
  const server = await serverService.ensureExists(serverId);
  const host = normalizeHost(server.joinHost);
  const target = await validateOutboundTarget(host, server.joinPort, { label: 'MOTD verification' });
  const address = target.addresses.find((entry) => entry.family === 4) ?? target.addresses[0];
  if (!address) {
    throw new Error('MOTD verification: no validated address');
  }

  const timeout = 5000;
  if (server.edition === 'bedrock') {
    const response = await statusBedrock(address.address, target.port, { timeout });
    const motd = extractMotd(response.motd);
    return motd.includes(token);
  }
  const response = await status(address.address, target.port, { timeout });
  const motd = extractMotd(response.motd);
  return motd.includes(token);
}

function normalizeHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      return trimmed;
    }
  }
  return trimmed.split('/')[0]?.split(':')[0] ?? trimmed;
}

function matchesToken(value: string, token: string): boolean {
  const trimmed = value.trim();
  if (trimmed === token) {
    return true;
  }
  return [
    `cv-verify=${token}`,
    `cv-verify:${token}`,
    `_claim:${token}`,
    `txt=_claim:${token}`,
  ].some((pattern) => trimmed.includes(pattern));
}

function extractMotd(raw: unknown): string {
  if (typeof raw === 'string') {
    return stripFormatting(raw);
  }
  if (raw && typeof raw === 'object') {
    const maybe = raw as { clean?: string; raw?: string[] };
    if (typeof maybe.clean === 'string') {
      return stripFormatting(maybe.clean);
    }
    if (Array.isArray(maybe.raw)) {
      return stripFormatting(maybe.raw.join(' '));
    }
  }
  return '';
}

function stripFormatting(value: string): string {
  return value.replace(/§[0-9A-FK-OR]/gi, '').trim();
}

function isSupportedClaimMethod(value: string): value is ClaimMethod {
  return value === 'plugin' || value === 'dns' || value === 'motd';
}
