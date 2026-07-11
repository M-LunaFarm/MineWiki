import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DiscordDigestJob } from '@minewiki/schemas';
import { loadDiscordDigestExecutionJob } from './discord-digest-job-loader';

test('digest queue hides channel settings and hydrates the current subscription', async () => {
  const scheduledFor = '2026-07-11T00:00:00.000Z';
  const job: DiscordDigestJob = { guildId: 'guild-private', scheduledFor };
  const prisma = {
    discordSubscription: {
      findUnique: async () => ({
        guildId: job.guildId,
        channelId: 'channel-private',
        timezone: 'Asia/Seoul',
        roleRewardId: 'role-private',
        nextDigestAt: new Date(scheduledFor),
      }),
    },
  };

  const queued = JSON.stringify(job);
  for (const privateValue of ['channel-private', 'Asia/Seoul', 'role-private']) {
    assert.equal(queued.includes(privateValue), false);
  }

  const execution = await loadDiscordDigestExecutionJob(prisma as never, job);
  assert.equal(execution.channelId, 'channel-private');
  assert.equal(execution.timezone, 'Asia/Seoul');
  assert.equal(execution.roleRewardId, 'role-private');
});

test('digest loader rejects stale scheduled jobs', async () => {
  const job: DiscordDigestJob = {
    guildId: 'guild-1',
    scheduledFor: '2026-07-11T00:00:00.000Z',
  };
  const prisma = {
    discordSubscription: {
      findUnique: async () => ({
        guildId: job.guildId,
        channelId: 'channel-1',
        timezone: 'UTC',
        roleRewardId: null,
        nextDigestAt: new Date('2026-07-12T00:00:00.000Z'),
      }),
    },
  };

  await assert.rejects(
    () => loadDiscordDigestExecutionJob(prisma as never, job),
    /discord_digest_stale_job/,
  );
});
