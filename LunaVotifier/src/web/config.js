const path = require('path');
require('dotenv').config({ path: process.env.WEB_ENV_FILE || path.resolve(process.cwd(), '.env') });

const port = Number(process.env.WEB_PORT || 3000);

module.exports = {
  port,
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${port}`,
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'lunaf_verify'
  },
  internalApiKey: process.env.INTERNAL_API_KEY || '',
  adminApiKey: process.env.ADMIN_API_KEY || '',
  sessionSecret: process.env.SESSION_SECRET || 'change-me',
  discordBotToken: process.env.DISCORD_TOKEN || '',
  discordBotClientId: process.env.DISCORD_CLIENT_ID || '',
  botInvitePermissions: process.env.BOT_INVITE_PERMISSIONS || '402721792',
  botWebhookUrl: process.env.BOT_WEBHOOK_URL || '',
  botSharedSecret: process.env.BOT_SHARED_SECRET || '',
  allowMockMsLogin: process.env.ALLOW_MOCK_MS_LOGIN === '1',
  verifySessionTtlMinutes: Number(process.env.VERIFY_SESSION_TTL_MINUTES || 10),
  pushTimeoutMs: Number(process.env.PUSH_TIMEOUT_MS || 5000),
  assetVersion: process.env.ASSET_VERSION || '20260214-1',
  discordOAuth: {
    clientId: process.env.DISCORD_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_OAUTH_CLIENT_SECRET || '',
    redirectUri: process.env.DISCORD_OAUTH_REDIRECT_URI || '',
    scopes: process.env.DISCORD_OAUTH_SCOPES || 'identify guilds'
  },
  microsoftOAuth: {
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    redirectUri: process.env.MS_REDIRECT_URI || '',
    tenant: process.env.MS_TENANT || 'common'
  }
};
