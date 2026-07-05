import { REST } from '@discordjs/rest';
import {
  Routes,
  ApplicationCommandOptionType,
  ChannelType
} from 'discord-api-types/v10';
import { Client, GatewayIntentBits, Interaction } from 'discord.js';
import { DateTime } from 'luxon';
import { ConfigService } from '@creepervote/config';
import { Logger } from '@creepervote/logger';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { discordDigestJobSchema } from '@creepervote/schemas';
import { SubscriptionStore } from './subscriptions';
import {
  createPreviewContent,
  createRankContent,
  createRisingContent,
  createRewardsContent
} from './digest';
import {
  fetchDigestSummary,
  fetchRankEntries,
  fetchRisingEntries
} from './digest-data';

const config = new ConfigService();
const token = config.getOptional('DISCORD_BOT_TOKEN');
const clientId = config.getOptional('DISCORD_CLIENT_ID');

if (!token || !clientId) {
  Logger.warn('Discord bot token or client ID missing; bot will not start.');
} else {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });
  const rest = new REST({ version: '10' }).setToken(token);
  const prisma = new PrismaClient();
  const subscriptions = new SubscriptionStore(prisma);
  const redisUrl = config.get('REDIS_URL', 'redis://localhost:6379');
  const digestQueue = new Queue('discord-digest', {
    connection: { url: redisUrl },
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 500
    }
  });

  client.once('ready', async () => {
    Logger.info({ tag: client.user?.tag }, 'Discord bot ready');
    try {
      await registerCommands(rest, clientId);
      Logger.info('Registered global Discord application commands.');
    } catch (error) {
      Logger.error({ err: error }, 'Failed to register Discord commands');
    }
    await processDueDigests(subscriptions, digestQueue);
  });

  client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }
    if (interaction.commandName !== 'creepervote') {
      return;
    }
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    switch (subcommand) {
      case 'subscribe': {
        if (!guildId) {
          await interaction.reply({
            content: 'This command is only available inside a guild.',
            ephemeral: true
          });
          return;
        }

        const channel =
          interaction.options.getChannel('channel') ??
          interaction.channel;
        if (
          !channel ||
          !('isTextBased' in channel) ||
          typeof channel.isTextBased !== 'function' ||
          !channel.isTextBased()
        ) {
          await interaction.reply({
            content: 'Pick a text channel to receive the daily digest.',
            ephemeral: true
          });
          return;
        }

        const timezoneInput = interaction.options.getString('timezone') ?? undefined;
        const role = interaction.options.getRole('role');

        try {
          const record = await subscriptions.upsert(guildId, {
            channelId: channel.id,
            timezone: timezoneInput,
            roleRewardId: role?.id
          });
          const nextDigestLocal = DateTime.fromISO(record.nextDigestAt, {
            zone: 'utc'
          })
            .setZone(record.timezone)
            .toFormat('LLL dd HH:mm (ZZ)');

          await interaction.reply({
            content: [
              `Channel: <#${record.channelId}>`,
              `Timezone: ${record.timezone}`,
              role ? `Reward role: <@&${role.id}>` : 'Reward role: not set',
              `Next digest: ${nextDigestLocal}`
            ].join('\n'),
            ephemeral: true
          });
        } catch (error) {
          Logger.warn({ err: error, guildId }, 'Failed to register subscription');
          await interaction.reply({
            content: error instanceof Error ? error.message : 'Failed to save subscription.',
            ephemeral: true
          });
        }
        break;
      }
      case 'preview': {
        try {
          const summary = await fetchDigestSummary(prisma);
          await interaction.reply({
            ...createPreviewContent(summary),
            ephemeral: true
          });
        } catch (error) {
          Logger.error({ err: error }, 'Failed to build preview digest');
          await interaction.reply({
            content: 'Unable to build digest preview right now.',
            ephemeral: true
          });
        }
        break;
      }
      case 'rank': {
        try {
          const entries = await fetchRankEntries(prisma, 5);
          await interaction.reply({
            ...createRankContent(entries),
            ephemeral: true
          });
        } catch (error) {
          Logger.error({ err: error }, 'Failed to load rank data');
          await interaction.reply({
            content: 'Unable to load ranking data right now.',
            ephemeral: true
          });
        }
        break;
      }
      case 'rising': {
        try {
          const entries = await fetchRisingEntries(prisma, 5);
          await interaction.reply({
            ...createRisingContent(entries),
            ephemeral: true
          });
        } catch (error) {
          Logger.error({ err: error }, 'Failed to load rising data');
          await interaction.reply({
            content: 'Unable to load rising servers right now.',
            ephemeral: true
          });
        }
        break;
      }
      case 'rewards': {
        const subscription = guildId ? await subscriptions.get(guildId) : undefined;
        await interaction.reply({
          ...createRewardsContent(subscription),
          ephemeral: true
        });
        break;
      }
      default:
        await interaction.reply({
          content: 'Unsupported command.',
          ephemeral: true
        });
    }
  });

  client.on('guildDelete', (guild) => {
    if (guild.id) {
      void subscriptions.remove(guild.id).catch((error) => {
        Logger.warn({ err: error, guildId: guild.id }, 'Failed to remove subscription');
      });
      Logger.warn({ guildId: guild.id }, 'Removed guild subscription after bot removal.');
    }
  });

  setInterval(() => {
    processDueDigests(subscriptions, digestQueue).catch((error) => {
      Logger.error({ err: error }, 'Digest scheduling loop failed');
    });
  }, 60_000);

  client.login(token).catch((error) => {
    Logger.error({ err: error }, 'Failed to log in to Discord');
  });

  const shutdown = async (signal: string) => {
    Logger.warn({ signal }, 'Shutting down Discord bot');
    await digestQueue.close();
    await prisma.$disconnect();
    client.destroy();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function registerCommands(rest: REST, clientId: string): Promise<void> {
  await rest.put(Routes.applicationCommands(clientId), {
    body: [
      {
        name: 'creepervote',
        description: 'Manage CreeperVote community digests.',
        options: [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'subscribe',
            description: 'Configure daily digest delivery for this guild.',
            options: [
              {
                type: ApplicationCommandOptionType.Channel,
                name: 'channel',
                description: 'Text channel to receive the digest.',
                required: false,
                channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement]
              },
              {
                type: ApplicationCommandOptionType.String,
                name: 'timezone',
                description: 'IANA timezone (e.g. Asia/Seoul).',
                required: false
              },
              {
                type: ApplicationCommandOptionType.Role,
                name: 'role',
                description: 'Role to mention with the digest.',
                required: false
              }
            ]
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'preview',
            description: 'Preview the daily digest.'
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'rank',
            description: 'Show the current leaderboard.'
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'rising',
            description: 'Show the fastest rising servers.'
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: 'rewards',
            description: 'Show reward role settings.'
          }
        ]
      }
    ]
  });
}

async function processDueDigests(
  store: SubscriptionStore,
  queue: Queue
): Promise<void> {
  const due = await store.due(new Date());
  if (due.length === 0) {
    return;
  }

  for (const subscription of due) {
    const job = discordDigestJobSchema.parse({
      guildId: subscription.guildId,
      channelId: subscription.channelId,
      scheduledFor: subscription.nextDigestAt,
      timezone: subscription.timezone
    });

    try {
      await queue.add('digest', job, {
        jobId: `digest:${subscription.guildId}:${subscription.nextDigestAt}`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('already exists')) {
        continue;
      }
      Logger.warn({ err: error, guildId: subscription.guildId }, 'Failed to enqueue digest job');
    }
  }
}
