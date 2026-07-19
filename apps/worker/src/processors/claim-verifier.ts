import { Logger } from '@minewiki/logger';
import { validateOutboundTarget } from '@minewiki/security';
import {
  classifyServerOwnershipProofResult,
  isServerOwnershipManagementSuspended,
  serverOwnershipVerificationTransition,
  type ClaimVerificationJob,
} from '@minewiki/schemas';
import { isSupportedClaimMethod, type ClaimMethod } from '@minewiki/schemas/claim-methods';
import type { PrismaClient } from '@prisma/client';
import { resolveTxt } from 'node:dns/promises';
import { status, statusBedrock } from 'minecraft-server-util';
import { decryptStoredSecret } from '../stored-secret';

const CHECK_TIMEOUT_MS = 5000;
const METHOD_EXPIRY_MS = 24 * 60 * 60 * 1000;

type ClaimMethodState = 'pending' | 'verified' | 'expired' | 'failed';
type VerificationGrade = 'A' | 'B' | 'C' | 'Unverified';

interface ClaimSnapshot {
  readonly id: string;
  readonly serverId: string;
  readonly method: ClaimMethod;
  readonly version: number;
  readonly token: string;
  readonly issuedAt: Date;
  readonly accountId?: string | null;
}

type PrismaHandle = Pick<PrismaClient, '$transaction' | 'server' | 'serverClaimMethod'>;

export interface ClaimVerificationResult {
  readonly status: ClaimMethodState;
  readonly checkedAt: string;
  readonly note?: string;
}

export function createClaimVerifier(
  prisma: PrismaHandle,
  dependencies: {
    readonly now?: () => Date;
    readonly runVerificationCheck?: typeof runVerificationCheck;
    readonly provisionServerWiki?: (serverId: string) => Promise<void>;
  } = {},
) {
  const logger = Logger.child({ component: 'ClaimVerifier' });
  const now = dependencies.now ?? (() => new Date());
  const check = dependencies.runVerificationCheck ?? runVerificationCheck;
  const provisionServerWiki = dependencies.provisionServerWiki ?? (async () => {});

  async function verify(job: ClaimVerificationJob): Promise<ClaimVerificationResult> {
    const checkedAt = now().toISOString();
    if (!isSupportedClaimMethod(job.method)) {
      logger.warn(
        { serverId: job.serverId, method: job.method },
        'Unsupported claim method in job payload',
      );
      return {
        status: 'failed',
        checkedAt,
        note: 'unsupported_method',
      };
    }

    const methodRecord = await prisma.serverClaimMethod.findUnique({
      where: {
        serverId_method: {
          serverId: job.serverId,
          method: job.method,
        },
      },
    });

    if (!methodRecord) {
      logger.warn({ serverId: job.serverId, method: job.method }, 'Claim method record missing');
      return { status: 'failed', checkedAt, note: 'method_not_issued' };
    }
    const snapshot: ClaimSnapshot = { ...methodRecord, method: job.method };

    if (
      methodRecord.status === 'pending'
      && now().getTime() - methodRecord.issuedAt.getTime() > METHOD_EXPIRY_MS
    ) {
      const result = {
        status: 'expired' as const,
        checkedAt,
        note: 'token_expired',
      };
      const applied = await applyVerificationResult(prisma, snapshot, result);
      return applied
        ? result
        : { status: 'pending', checkedAt, note: 'claim_generation_changed' };
    }

    const proof = resolveVerificationProof(methodRecord.token, methodRecord.tokenCiphertext);
    if (!proof) {
      const result = {
        status: methodRecord.status as ClaimMethodState,
        checkedAt,
        note: 'verification_proof_unavailable',
      };
      await prisma.serverClaimMethod.updateMany({
        where: {
          id: methodRecord.id,
          version: methodRecord.version,
          token: methodRecord.token,
          issuedAt: methodRecord.issuedAt,
        },
        data: {
          version: { increment: 1 },
          lastCheckedAt: new Date(checkedAt),
          note: result.note,
        },
      });
      return result;
    }

    const result = await check(job.method, proof ?? '', job.serverId, prisma);
    const applied = await applyVerificationResult(prisma, snapshot, result);
    if (applied && result.status === 'verified') {
      await provisionServerWiki(job.serverId);
    }
    return applied
      ? result
      : { status: 'pending', checkedAt, note: 'claim_generation_changed' };
  }

  return { verify };
}

export function resolveVerificationProof(
  storedToken: string,
  tokenCiphertext: string | null | undefined,
): string | null {
  const decrypted = decryptStoredSecret(tokenCiphertext);
  if (decrypted) {
    return decrypted;
  }
  return storedToken.startsWith('sha256:') || /^[a-f0-9]{64}$/i.test(storedToken)
    ? null
    : storedToken;
}

async function applyVerificationResult(
  prisma: PrismaHandle,
  snapshot: ClaimSnapshot,
  result: ClaimVerificationResult,
): Promise<boolean> {
  const checkedAt = new Date(result.checkedAt);
  return prisma.$transaction(async (transaction) => {
    let ownershipTakeover = false;
    const current = await transaction.server.findUnique({
      where: { id: snapshot.serverId },
      select: {
        ownerAccountId: true,
        registrantAccountId: true,
        listingStatus: true,
        ownershipVerificationFailures: true,
        ownershipChallengeStartedAt: true,
        ownershipChallengeExpiresAt: true,
        ownershipChallengeSuspendedAt: true,
        ownershipLastFailureAt: true,
      },
    });
    if (!current) return false;
    const updated = await transaction.serverClaimMethod.updateMany({
      where: {
        id: snapshot.id,
        version: snapshot.version,
        token: snapshot.token,
        issuedAt: snapshot.issuedAt,
      },
      data: {
        version: { increment: 1 },
        status: result.status,
        lastCheckedAt: checkedAt,
        note: result.note ?? null,
        verifiedAt: result.status === 'verified' ? checkedAt : null,
      },
    });
    if (updated.count !== 1) {
      return false;
    }

    if (result.status === 'verified') {
      if (!snapshot.accountId) {
        throw new Error('Verified claim is missing its account owner.');
      }
      const takeover = current.ownerAccountId !== null
        && current.registrantAccountId === snapshot.accountId
        && isServerOwnershipManagementSuspended(current);
      ownershipTakeover = takeover;
      const ownership = await transaction.server.updateMany({
        where: {
          id: snapshot.serverId,
          OR: [
            { ownerAccountId: null },
            { ownerAccountId: snapshot.accountId },
            ...(takeover ? [{
              ownerAccountId: current.ownerAccountId,
              registrantAccountId: snapshot.accountId,
              ownershipChallengeSuspendedAt: { not: null },
            }] : []),
          ],
        },
        data: {
          ownerAccountId: snapshot.accountId,
          registrantAccountId: takeover ? snapshot.accountId : null,
          registrationLeaseExpiresAt: null,
        },
      });
      if (ownership.count !== 1) {
        throw new Error('Verified claim conflicts with the current server owner.');
      }
    }

    const methods = await transaction.serverClaimMethod.findMany({
      where: { serverId: snapshot.serverId },
      select: { method: true, status: true },
    });
    const grade = computeGrade(methods);
    const ownership = serverOwnershipVerificationTransition(
      current,
      grade !== 'Unverified'
        ? 'verified'
        : classifyServerOwnershipProofResult(result),
      checkedAt,
    );
    await transaction.server.update({
      where: { id: snapshot.serverId },
      data: {
        verificationGrade: grade,
        verifiedAt: grade === 'Unverified' ? null : checkedAt,
        ownershipVerificationFailures: ownership.ownershipVerificationFailures,
        ownershipChallengeStartedAt: ownership.ownershipChallengeStartedAt,
        ownershipChallengeExpiresAt: ownership.ownershipChallengeExpiresAt,
        ownershipLastFailureAt: ownership.ownershipLastFailureAt,
        ownershipChallengeSuspendedAt: ownershipTakeover
          ? current.ownershipChallengeSuspendedAt
          : grade !== 'Unverified'
          ? null
          : ownership.challengeMatured
            ? current.ownershipChallengeSuspendedAt ?? checkedAt
            : current.ownershipChallengeSuspendedAt,
        listingStatus: ownershipTakeover
          ? 'suspended'
          : grade !== 'Unverified' && current.ownershipChallengeSuspendedAt
          ? 'active'
          : ownership.challengeMatured
            ? 'suspended'
            : undefined,
      },
    });
    if (grade !== 'Unverified' && snapshot.accountId) {
      await transaction.server.updateMany({
        where: {
          id: snapshot.serverId,
          listingStatus: 'pending',
          ownerAccountId: snapshot.accountId,
        },
        data: { listingStatus: 'active' },
      });
    }
    return true;
  });
}

async function runVerificationCheck(
  method: ClaimMethod,
  token: string,
  serverId: string,
  prisma: PrismaHandle,
): Promise<ClaimVerificationResult> {
  const checkedAt = new Date().toISOString();

  try {
    if (method === 'dns') {
      const outcome = await verifyDnsToken(serverId, token, prisma);
      return {
        status: outcome === 'verified' ? 'verified' : 'failed',
        checkedAt,
        note: outcome === 'verified'
          ? 'dns_token_confirmed'
          : outcome === 'absent'
            ? 'dns_token_not_found'
            : 'dns_lookup_inconclusive',
      };
    }
    if (method === 'motd') {
      const verified = await verifyMotdToken(serverId, token, prisma);
      return {
        status: verified ? 'verified' : 'failed',
        checkedAt,
        note: verified ? 'motd_token_confirmed' : 'motd_token_not_found',
      };
    }
  } catch (error) {
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

function computeGrade(
  methods: Array<{ method: string; status: ClaimMethodState }>,
): VerificationGrade {
  return methods.some(
    (method) => isSupportedClaimMethod(method.method) && method.status === 'verified',
  ) ? 'A' : 'Unverified';
}

export async function verifyDnsToken(
  serverId: string,
  token: string,
  prisma: PrismaHandle,
  resolveRecords: (name: string) => Promise<string[][]> = resolveTxt,
): Promise<'verified' | 'absent' | 'inconclusive'> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) {
    return 'inconclusive';
  }
  const host = normalizeHost(server.joinHost);
  const recordNames = [`_cvverify.${host}`, `_minewiki.${host}`, `_claim.${host}`, host];
  let inconclusive = false;

  for (const name of recordNames) {
    try {
      const records = await resolveRecords(name);
      const flattened = records.flat().map((entry) => entry.trim());
      if (flattened.some((entry) => matchesToken(entry, token))) {
        return 'verified';
      }
    } catch (error) {
      if (!isConfirmedDnsAbsence(error)) inconclusive = true;
    }
  }
  return inconclusive ? 'inconclusive' : 'absent';
}

function isConfirmedDnsAbsence(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';
  return code === 'ENODATA' || code === 'ENOTFOUND';
}

async function verifyMotdToken(
  serverId: string,
  token: string,
  prisma: PrismaHandle,
): Promise<boolean> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) {
    return false;
  }
  const host = normalizeHost(server.joinHost);
  const target = await validateOutboundTarget(host, server.joinPort, { label: 'MOTD verification' });
  const address = target.addresses.find((entry) => entry.family === 4) ?? target.addresses[0];
  if (!address) {
    throw new Error('MOTD verification: no validated address');
  }

  if (server.edition === 'bedrock') {
    const response = await statusBedrock(address.address, target.port, { timeout: CHECK_TIMEOUT_MS });
    const motd = extractMotd(response.motd);
    return motd.includes(token);
  }
  const response = await status(address.address, target.port, { timeout: CHECK_TIMEOUT_MS });
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
