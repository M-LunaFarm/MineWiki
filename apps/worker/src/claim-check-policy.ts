import type { Prisma } from '@prisma/client';
import {
  SERVER_OWNERSHIP_CHALLENGE_FAILURE_INTERVAL_MS,
} from '@minewiki/schemas';
import { SUPPORTED_CLAIM_METHODS } from '@minewiki/schemas/claim-methods';

const CLAIM_PENDING_THRESHOLD_MS = 60 * 60 * 1000;
const CLAIM_VERIFIED_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function buildClaimCheckDueWhere(now: Date): Prisma.ServerClaimMethodWhereInput {
  const threshold = (ageMs: number) => new Date(now.getTime() - ageMs);
  return {
    method: { in: [...SUPPORTED_CLAIM_METHODS] },
    OR: [
      {
        status: 'pending',
        OR: [
          { lastCheckedAt: null },
          { lastCheckedAt: { lt: threshold(CLAIM_PENDING_THRESHOLD_MS) } },
        ],
      },
      {
        status: 'verified',
        OR: [
          { lastCheckedAt: null },
          { lastCheckedAt: { lt: threshold(CLAIM_VERIFIED_THRESHOLD_MS) } },
        ],
      },
      {
        status: 'failed',
        server: { ownerAccountId: { not: null } },
        OR: [
          { lastCheckedAt: null },
          {
            lastCheckedAt: {
              lt: threshold(SERVER_OWNERSHIP_CHALLENGE_FAILURE_INTERVAL_MS),
            },
          },
        ],
      },
    ],
  };
}
