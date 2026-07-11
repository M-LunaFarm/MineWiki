import type { PrismaClient } from '@prisma/client';
import type { VoteDispatchJob } from '@minewiki/schemas';
import { decryptStoredSecret } from './stored-secret';
import type {
  VoteDispatchExecutionJob,
  VoteDispatchExecutionTarget,
} from './processors/vote-dispatcher';

type PrismaHandle = Pick<PrismaClient, 'vote' | 'votifierTarget'>;

export async function loadVoteDispatchExecutionJob(
  prisma: PrismaHandle,
  job: VoteDispatchJob,
): Promise<VoteDispatchExecutionJob> {
  const targetIds = job.targets.map((target) => target.targetId);
  const [vote, storedTargets] = await Promise.all([
    prisma.vote.findFirst({
      where: { id: job.voteId, serverId: job.serverId },
      select: { username: true, ipAddress: true, votedAt: true },
    }),
    prisma.votifierTarget.findMany({
      where: { id: { in: targetIds }, serverId: job.serverId },
    }),
  ]);
  if (!vote) {
    throw new Error('vote_dispatch_vote_not_found');
  }

  const targetsById = new Map(storedTargets.map((target) => [target.id, target]));
  const targets: VoteDispatchExecutionTarget[] = job.targets.map((reference) => {
    const target = targetsById.get(reference.targetId);
    if (!target) {
      throw new Error('vote_dispatch_target_not_found');
    }
    return {
      targetId: target.id,
      dispatchAttemptId: reference.dispatchAttemptId,
      protocol: target.protocol === 'v1' ? 'v1' : 'v2',
      host: target.host,
      port: target.port,
      token: decryptStoredSecret(target.token) ?? undefined,
      publicKey: target.publicKey ?? undefined,
    };
  });

  return {
    voteId: job.voteId,
    serverId: job.serverId,
    username: vote.username,
    ipAddress: vote.ipAddress ?? undefined,
    votedAt: vote.votedAt.toISOString(),
    targets,
  };
}
