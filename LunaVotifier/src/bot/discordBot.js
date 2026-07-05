const { Client, GatewayIntentBits, Partials, REST, Routes, Events, MessageFlags, ActivityType } = require('discord.js');
const fetch = require('node-fetch');
const config = require('./config');

async function registerCommands() {
  const commands = [
    {
      name: 'verify',
      description: '마인크래프트 계정 인증을 시작합니다.'
    }
  ];

  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  if (config.discordGuildId) {
    await rest.put(
      Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
      { body: commands }
    );
  } else {
    await rest.put(Routes.applicationCommands(config.discordClientId), { body: commands });
  }
}

async function createVerificationSession(guildId, userId, channelId) {
  const response = await fetch(`${config.webApiBaseUrl}/api/v1/verify/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': config.internalApiKey
    },
    body: JSON.stringify({ guild_id: guildId, discord_user_id: userId, channel_id: channelId })
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(`session_create_failed:${response.status}`);
    error.status = response.status;
    error.replyPayload = body?.reply_payload || null;
    throw error;
  }

  return body;
}

function formatNickname(template, ign, userName) {
  if (!template) {
    return null;
  }
  return template
    .replace('{ign}', ign || '')
    .replace('{user}', userName || '')
    .trim();
}

function formatBotMessage(template, payload, member) {
  if (!template) {
    return null;
  }
  const userMention = payload.discord_user_id ? `<@${payload.discord_user_id}>` : '';
  return String(template)
    .replace('{user}', userMention)
    .replace('{username}', member?.user?.username || '')
    .replace('{ign}', payload.mc_ign || '')
    .replace('{uuid}', payload.mc_uuid || '')
    .replace('{discord_id}', payload.discord_user_id || '')
    .replace('{guild_id}', payload.guild_id || '')
    .trim();
}

function defaultBotMessage(payload) {
  if (payload.event_type === 'verification.completed') {
    return `✅ <@${payload.discord_user_id}> verified as **${payload.mc_ign || 'unknown'}**`;
  }
  if (payload.event_type === 'verification.reverified') {
    return `🔄 <@${payload.discord_user_id}> re-verified as **${payload.mc_ign || 'unknown'}**`;
  }
  if (payload.event_type === 'verification.revoked') {
    return `⛔ <@${payload.discord_user_id}> verification revoked`;
  }
  return `Verify event: ${payload.event_type} for <@${payload.discord_user_id}> (${payload.mc_ign || 'unknown'})`;
}

function parseJsonMaybe(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (err) {
      return null;
    }
  }
  if (typeof value === 'object') {
    return value;
  }
  return null;
}

function replaceTokens(text, tokens) {
  return String(text).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(tokens, key)) {
      return tokens[key];
    }
    return '';
  });
}

function applyTemplate(value, tokens) {
  if (typeof value === 'string') {
    return replaceTokens(value, tokens);
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyTemplate(item, tokens));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((acc, key) => {
      acc[key] = applyTemplate(value[key], tokens);
      return acc;
    }, {});
  }
  return value;
}

function resolveTemplate(templatePayload, key) {
  const parsed = parseJsonMaybe(templatePayload);
  if (!parsed) {
    return null;
  }
  if (parsed.content || parsed.embeds || parsed.components) {
    return parsed;
  }
  if (parsed[key]) {
    return parsed[key];
  }
  if (parsed.default) {
    return parsed.default;
  }
  return null;
}

function buildTokenMap(payload, member, extra = {}) {
  const discordId = payload?.discord_user_id || extra.discord_id || '';
  const username = member?.user?.username || extra.username || '';
  const tag = member?.user?.tag || extra.tag || '';
  const userMention = discordId ? `<@${discordId}>` : '';

  return {
    user: userMention,
    username,
    tag,
    ign: payload?.mc_ign || extra.ign || '',
    uuid: payload?.mc_uuid || extra.uuid || '',
    discord_id: discordId,
    guild_id: payload?.guild_id || extra.guild_id || '',
    verify_url: extra.verify_url || ''
  };
}

function buildMessagePayload(templatePayload, key, tokens) {
  const resolved = resolveTemplate(templatePayload, key);
  if (!resolved) {
    return null;
  }
  const rendered = applyTemplate(resolved, tokens);
  if (typeof rendered === 'string') {
    return { content: rendered };
  }
  return rendered;
}

async function handleBotEvent(client, payload) {
  const guild = await client.guilds.fetch(payload.guild_id).catch(() => null);
  if (!guild) {
    return { status: 'guild_not_found' };
  }

  const member = await guild.members.fetch(payload.discord_user_id).catch(() => null);
  if (!member) {
    return { status: 'member_not_found' };
  }

  const tokens = buildTokenMap(payload, member);

  if (payload.event_type === 'verification.completed' || payload.event_type === 'verification.reverified') {
    if (payload.verified_role_id) {
      await member.roles.add(payload.verified_role_id).catch(() => null);
    }

    const nickname = formatNickname(payload.nickname_format, payload.mc_ign, member.user.username);
    if (nickname) {
      await member.setNickname(nickname).catch(() => null);
    }

    const dmPayload = buildMessagePayload(payload.bot_message_payload, 'dm.verification.completed', tokens);
    if (dmPayload) {
      await member.send(dmPayload).catch(() => null);
    }
  }

  if (payload.event_type === 'verification.revoked') {
    if (payload.verified_role_id) {
      await member.roles.remove(payload.verified_role_id).catch(() => null);
    }
  }

  if (payload.log_channel_id) {
    const channel = await guild.channels.fetch(payload.log_channel_id).catch(() => null);
    if (channel && channel.isTextBased()) {
      const richPayload = buildMessagePayload(payload.bot_message_payload, payload.event_type, tokens);
      if (richPayload) {
        await channel.send(richPayload).catch(() => null);
      } else {
        const message = formatBotMessage(payload.bot_message_template, payload, member) || defaultBotMessage(payload);
        await channel.send(message).catch(() => null);
      }
    }
  }

  return { status: 'ok' };
}

async function startDiscordBot() {
  if (!config.discordToken || !config.discordClientId) {
    throw new Error('missing_discord_config');
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.GuildMember]
  });

  client.once(Events.ClientReady, async () => {
    await registerCommands();
    client.user.setPresence({
      activities: [
        {
          name: 'verify.lunaf.kr · 디스코드: discord.gg/HPh2xYjSVH',
          type: ActivityType.Playing
        }
      ],
      status: 'online'
    });
    // eslint-disable-next-line no-console
    console.log(`Bot logged in as ${client.user.tag}`);
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === 'verify') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const session = await createVerificationSession(interaction.guildId, interaction.user.id, interaction.channelId);
        const tokens = buildTokenMap(
          { discord_user_id: interaction.user.id, guild_id: interaction.guildId },
          null,
          {
            username: interaction.user.username,
            tag: interaction.user.tag,
            verify_url: session.verify_url
          }
        );
        const richPayload = buildMessagePayload(session.reply_payload, 'verify.start', tokens)
          || buildMessagePayload(session.reply_payload, 'verify.success', tokens);
        if (richPayload) {
          await interaction.editReply(richPayload);
        } else {
          await interaction.editReply(`Complete verification: ${session.verify_url}`);
        }
      } catch (err) {
        let message = 'Failed to create verification session.';
        if (err?.status === 403) {
          message = '검증 서버 접근이 거부되었습니다. 관리자에게 문의해주세요.';
        } else if (err?.status === 500) {
          message = '검증 서버 설정 오류입니다. 관리자에게 문의해주세요.';
        } else if (err?.status) {
          message = '검증 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.';
        }
        const errorKey = err?.status === 403
          ? 'verify.error.forbidden'
          : err?.status === 500
            ? 'verify.error.server'
            : err?.status
              ? 'verify.error.unreachable'
              : 'verify.error.default';
        const tokens = buildTokenMap(
          { discord_user_id: interaction.user.id, guild_id: interaction.guildId },
          null,
          { username: interaction.user.username, tag: interaction.user.tag }
        );
        const richPayload = buildMessagePayload(err?.replyPayload, errorKey, tokens);
        // eslint-disable-next-line no-console
        console.error('verify session error:', err?.message || err);
        await interaction.editReply(richPayload || message);
      }
    }
  });

  await client.login(config.discordToken);

  return { client, handleBotEvent: (payload) => handleBotEvent(client, payload) };
}

module.exports = {
  startDiscordBot
};
