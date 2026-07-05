const path = require('path');
require('dotenv').config({ path: process.env.BOT_ENV_FILE || path.resolve(process.cwd(), '.env') });

module.exports = {
  discordToken: process.env.DISCORD_TOKEN || '',
  discordClientId: process.env.DISCORD_CLIENT_ID || '',
  discordGuildId: process.env.DISCORD_GUILD_ID || '',
  webApiBaseUrl: process.env.WEB_API_BASE_URL || 'http://localhost:3000',
  internalApiKey: process.env.INTERNAL_API_KEY || '',
  botPort: Number(process.env.BOT_PORT || 3100),
  botSharedSecret: process.env.BOT_SHARED_SECRET || ''
};
