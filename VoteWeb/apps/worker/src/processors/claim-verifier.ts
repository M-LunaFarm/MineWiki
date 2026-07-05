import { Logger } from '@creepervote/logger';
import { validateOutboundTarget } from '@creepervote/security';
import type { ClaimVerificationJob } from '@creepervote/schemas';
import type { PrismaClient } from '@prisma/client';
import { resolveTxt } from 'node:dns/promises';
import { status, statusBedrock } from 'minecraft-server-util';

const CHECK_TIMEOUT_MS = 5000;
const METHOD_EXPIRY_MS = 24 * 60 * 60 * 1000;

type ClaimMethod = 'plugin' | 'dns' | 'motd';
type ClaimMethodState = 'pending' | 'verified' | 'expired' | 'failed';
type VerificationGrade = 'A' | 'B' | 'C' | 'Unverified';

type PrismaHandle = Pick<PrismaClient, 'server' | 'serverClaimMethod'>;

export interface ClaimVerificationResult {
  readonly status: ClaimMethodState;
  readonly checkedAt: string;
  readonly note?: string;
}

export function createClaimVerifier(prisma: PrismaHandle) {
  const logger = Logger.child({ component: 'ClaimVerifier' });

  async function verify(job: ClaimVerificationJob): Promise<ClaimVerificationResult> {
    const checkedAt = new Date().toISOString();
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

    if (
      methodRecord.status === 'verified' &&
      methodRecord.verifiedAt &&
      Date.now() - methodRecord.verifiedAt.getTime() > METHOD_EXPIRY_MS
    ) {
      const result = {
        status: 'expired' as const,
        checkedAt,
        note: 'token_expired',
      };
      await applyVerificationResult(prisma, job.serverId, job.method, result);
      return result;
    }

    const result = await runVerificationCheck(job.method, methodRecord.token, job.serverId, prisma);
    await applyVerificationResult(prisma, job.serverId, job.method, result);
    return result;
  }

  return { verify };
}

async function applyVerificationResult(
  prisma: PrismaHandle,
  serverId: string,
  method: ClaimMethod,
  result: ClaimVerificationResult,
): Promise<void> {
  const checkedAt = new Date(result.checkedAt);
  await prisma.serverClaimMethod.update({
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

  const methods = await prisma.serverClaimMethod.findMany({
    where: { serverId },
    select: { method: true, status: true },
  });
  const grade = computeGrade(methods);
  await prisma.server.update({
    where: { id: serverId },
    data: {
      verificationGrade: grade,
      verifiedAt: grade === 'Unverified' ? null : checkedAt,
    },
  });
}

async function runVerificationCheck(
  method: ClaimMethod,
  token: string,
  serverId: string,
  prisma: PrismaHandle,
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
      const verified = await verifyDnsToken(serverId, token, prisma);
      return {
        status: verified ? 'verified' : 'failed',
        checkedAt,
        note: verified ? 'dns_token_confirmed' : 'dns_token_not_found',
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
  return methods.some((method) => method.status === 'verified') ? 'A' : 'Unverified';
}

async function verifyDnsToken(
  serverId: string,
  token: string,
  prisma: PrismaHandle,
): Promise<boolean> {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) {
    return false;
  }
  const host = normalizeHost(server.joinHost);
  const recordNames = [`_cvverify.${host}`, `_creepervote.${host}`, `_claim.${host}`, host];

  for (const name of recordNames) {
    try {
      const records = await resolveTxt(name);
      const flattened = records.flat().map((entry) => entry.trim());
      if (flattened.some((entry) => matchesToken(entry, token))) {
        return true;
      }
    } catch {
      // ignore lookup failures
    }
  }
  return false;
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
  await validateOutboundTarget(host, server.joinPort, { label: 'MOTD verification' });

  if (server.edition === 'bedrock') {
    const response = await statusBedrock(host, server.joinPort, { timeout: CHECK_TIMEOUT_MS });
    const motd = extractMotd(response.motd);
    return motd.includes(token);
  }
  const response = await status(host, server.joinPort, { timeout: CHECK_TIMEOUT_MS });
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
