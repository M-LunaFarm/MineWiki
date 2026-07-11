import type { PrismaClient } from '@prisma/client';
import type { DiscordDigestJob } from '@minewiki/schemas';
import type { DiscordDigestExecutionJob } from './processors/discord-digest';

type PrismaHandle = Pick<PrismaClient, 'discordSubscription'>;

export async function loadDiscordDigestExecutionJob(
  prisma: PrismaHandle,
  job: DiscordDigestJob,
): Promise<DiscordDigestExecutionJob> {
  const subscription = await prisma.discordSubscription.findUnique({
    where: { guildId: job.guildId },
  });
  if (!subscription) {
    throw new Error('discord_digest_subscription_not_found');
  }
  if (subscription.nextDigestAt.toISOString() !== job.scheduledFor) {
    throw new Error('discord_digest_stale_job');
  }
  return {
    ...job,
    channelId: subscription.channelId,
    timezone: subscription.timezone,
    roleRewardId: subscription.roleRewardId ?? undefined,
  };
}
