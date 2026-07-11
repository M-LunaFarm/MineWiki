import type {
  ClaimVerificationJob,
  DiscordDigestJob,
  DiscordVerifySyncJob,
  RankAggregationJob,
  ServerPingJob,
  VoteDispatchJob,
} from '@minewiki/schemas';

export function voteDispatchLogContext(job: VoteDispatchJob) {
  return { serverId: job.serverId, voteId: job.voteId, targetCount: job.targets.length };
}

export function serverPingLogContext(job: ServerPingJob) {
  return { serverId: job.serverId };
}

export function claimVerificationLogContext(job: ClaimVerificationJob) {
  return { serverId: job.serverId, method: job.method };
}

export function rankAggregationLogContext(_job: RankAggregationJob) {
  void _job;
  return {};
}

export function discordDigestLogContext(job: DiscordDigestJob) {
  return { guildId: job.guildId, scheduledFor: job.scheduledFor };
}

export function discordVerifySyncLogContext(job: DiscordVerifySyncJob) {
  return { sessionId: job.sessionId, action: job.action ?? 'link' };
}
