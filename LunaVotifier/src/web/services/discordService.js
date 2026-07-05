const fetch = require('node-fetch');
const config = require('../config');

function getDiscordAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: config.discordOAuth.clientId,
    response_type: 'code',
    redirect_uri: config.discordOAuth.redirectUri,
    scope: config.discordOAuth.scopes,
    state
  });

  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

async function exchangeDiscordCode(code) {
  const params = new URLSearchParams({
    client_id: config.discordOAuth.clientId,
    client_secret: config.discordOAuth.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.discordOAuth.redirectUri
  });

  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  if (!response.ok) {
    throw new Error(`discord_token_failed:${response.status}`);
  }

  return response.json();
}

async function fetchDiscordUser(accessToken) {
  const response = await fetch('https://discord.com/api/users/@me', {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`discord_user_failed:${response.status}`);
  }

  return response.json();
}

async function fetchDiscordGuilds(accessToken) {
  const response = await fetch('https://discord.com/api/users/@me/guilds', {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`discord_guilds_failed:${response.status}`);
  }

  return response.json();
}

async function fetchBotGuildPresence(guildId) {
  if (!config.discordBotToken) {
    return false;
  }
  const response = await fetch(`https://discord.com/api/guilds/${guildId}`, {
    headers: {
      Authorization: `Bot ${config.discordBotToken}`
    }
  });
  return response.ok;
}

async function fetchBotGuildInfo(guildId) {
  if (!config.discordBotToken) {
    return {
      present: false,
      ownerId: null,
      memberCount: null,
      presenceCount: null,
      name: null,
      icon: null
    };
  }
  const response = await fetch(`https://discord.com/api/guilds/${guildId}?with_counts=true`, {
    headers: {
      Authorization: `Bot ${config.discordBotToken}`
    }
  });
  if (!response.ok) {
    return {
      present: false,
      ownerId: null,
      memberCount: null,
      presenceCount: null,
      name: null,
      icon: null
    };
  }
  const data = await response.json();
  return {
    present: true,
    ownerId: data.owner_id || null,
    memberCount: data.approximate_member_count ?? data.member_count ?? null,
    presenceCount: data.approximate_presence_count ?? null,
    name: data.name || null,
    icon: data.icon || null
  };
}

async function fetchGuildChannels(guildId) {
  if (!config.discordBotToken) {
    return [];
  }
  const response = await fetch(`https://discord.com/api/guilds/${guildId}/channels`, {
    headers: {
      Authorization: `Bot ${config.discordBotToken}`
    }
  });
  if (!response.ok) {
    return [];
  }
  return response.json();
}

async function fetchGuildRoles(guildId) {
  if (!config.discordBotToken) {
    return [];
  }
  const response = await fetch(`https://discord.com/api/guilds/${guildId}/roles`, {
    headers: {
      Authorization: `Bot ${config.discordBotToken}`
    }
  });
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return (data || []).filter((role) => !role.managed);
}

async function fetchGuildMembers(guildId, limit = 50, after = null) {
  if (!config.discordBotToken) {
    return [];
  }
  const params = new URLSearchParams({ limit: String(limit) });
  if (after) {
    params.set('after', after);
  }
  const response = await fetch(`https://discord.com/api/guilds/${guildId}/members?${params.toString()}`, {
    headers: {
      Authorization: `Bot ${config.discordBotToken}`
    }
  });
  if (!response.ok) {
    return [];
  }
  return response.json();
}

async function searchGuildMembers(guildId, query, limit = 20) {
  if (!config.discordBotToken) {
    return [];
  }
  if (!guildId || !query) {
    return [];
  }
  const params = new URLSearchParams({ query: String(query), limit: String(limit) });
  const response = await fetch(`https://discord.com/api/guilds/${guildId}/members/search?${params.toString()}`, {
    headers: {
      Authorization: `Bot ${config.discordBotToken}`
    }
  });
  if (!response.ok) {
    return [];
  }
  return response.json();
}

async function fetchGuildMember(guildId, userId) {
  if (!config.discordBotToken) {
    return null;
  }
  if (!guildId || !userId) {
    return null;
  }
  const response = await fetch(`https://discord.com/api/guilds/${guildId}/members/${userId}`, {
    headers: {
      Authorization: `Bot ${config.discordBotToken}`
    }
  });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

function hasManageGuildPermission(permissions) {
  try {
    const bits = BigInt(permissions);
    const manageGuild = 0x20n;
    const administrator = 0x8n;
    return (bits & manageGuild) === manageGuild || (bits & administrator) === administrator;
  } catch (err) {
    return false;
  }
}

function filterManagedGuilds(guilds) {
  return (guilds || []).filter((guild) => hasManageGuildPermission(guild.permissions));
}

function classifyGuildAccess(guild, userId, ownerId) {
  try {
    if ((ownerId && userId && ownerId === userId) || guild?.owner) {
      return { key: 'owner', label: 'Owner', icon: '👑' };
    }
    const bits = BigInt(guild?.permissions || 0);
    const administrator = 0x8n;
    const manageGuild = 0x20n;
    if ((bits & administrator) === administrator) {
      return { key: 'admin', label: 'Admin', icon: '🛡️' };
    }
    if ((bits & manageGuild) === manageGuild) {
      return { key: 'manager', label: 'Manager', icon: '🧰' };
    }
  } catch (err) {
    // ignore
  }
  return { key: 'member', label: 'Member', icon: '👤' };
}

module.exports = {
  getDiscordAuthorizeUrl,
  exchangeDiscordCode,
  fetchDiscordUser,
  fetchDiscordGuilds,
  filterManagedGuilds,
  fetchBotGuildPresence,
  fetchBotGuildInfo,
  fetchGuildChannels,
  fetchGuildRoles,
  fetchGuildMembers,
  searchGuildMembers,
  fetchGuildMember,
  classifyGuildAccess
};
