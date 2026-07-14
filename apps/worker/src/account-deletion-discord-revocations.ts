import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const LOCK_STALE_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 20;

type PrismaHandle = Pick<PrismaClient, 'accountDeletionDiscordRevocation' | 'discordVerificationSession'>;

export interface DiscordRevocationSweepResult {
  readonly processed: number;
  readonly retried: number;
  readonly failed: number;
}

export async function processAccountDeletionDiscordRevocations(
  prisma: PrismaHandle,
  token: string,
  options: { readonly limit?: number; readonly fetchImpl?: typeof fetch; readonly now?: Date } = {},
): Promise<DiscordRevocationSweepResult> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const workerId = `worker:${randomUUID()}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  await prisma.accountDeletionDiscordRevocation.updateMany({
    where: { status: 'processing', lockedAt: { lte: new Date(now.getTime() - LOCK_STALE_MS) } },
    data: { status: 'pending', lockedAt: null, lockedBy: null },
  });
  const candidates = await prisma.accountDeletionDiscordRevocation.findMany({
    where: { status: 'pending', availableAt: { lte: now } },
    orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
    take: limit,
  });
  let processed = 0;
  let retried = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const claimed = await prisma.accountDeletionDiscordRevocation.updateMany({
      where: { id: candidate.id, status: 'pending', availableAt: { lte: now } },
      data: { status: 'processing', lockedAt: now, lockedBy: workerId, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;
    try {
      if (!token || !candidate.discordUserId || !candidate.roleId) throw new Error('discord_revocation_credentials_missing');
      const response = await fetchImpl(
        `${DISCORD_API_BASE}/guilds/${candidate.guildId}/members/${candidate.discordUserId}/roles/${candidate.roleId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bot ${token}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok && response.status !== 404) throw new Error(`discord_role_remove_failed_${response.status}`);
      await prisma.accountDeletionDiscordRevocation.update({
        where: { id: candidate.id },
        data: { status: 'completed', discordUserId: null, roleId: null, processedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null },
      });
      if (candidate.verificationSessionId) {
        await prisma.discordVerificationSession.updateMany({
          where: { id: candidate.verificationSessionId, status: 'revoke_pending' },
          data: { status: 'revoked', lastSyncStatus: 'account_deleted_role_revoked', lastSyncAt: new Date() },
        });
      }
      processed += 1;
    } catch (problem) {
      const attempts = candidate.attempts + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      await prisma.accountDeletionDiscordRevocation.update({
        where: { id: candidate.id },
        data: {
          status: terminal ? 'failed' : 'pending',
          availableAt: new Date(now.getTime() + retryDelayMs(attempts)),
          lockedAt: null,
          lockedBy: null,
          lastError: (problem instanceof Error ? problem.message : String(problem)).slice(0, 500),
        },
      });
      if (terminal) failed += 1;
      else retried += 1;
    }
  }
  return { processed, retried, failed };
}

function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.min(Math.max(attempts - 1, 0), 7)));
}
