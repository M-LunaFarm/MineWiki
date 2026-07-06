import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '../dist/index.js';

test('production config rejects missing required secrets', () => {
  assert.throws(
    () => new ConfigService({ NODE_ENV: 'production' }),
    /Production configuration is incomplete:.*DATABASE_URL.*APP_ENCRYPTION_KEY/s
  );
});

test('production config rejects placeholder secrets', () => {
  assert.throws(
    () =>
      new ConfigService({
        ...validProductionEnv(),
        PLUGIN_SYNC_TOKEN: 'change-me'
      }),
    /PLUGIN_SYNC_TOKEN still contains a placeholder value/
  );
});

test('production config accepts complete environment', () => {
  const config = new ConfigService(validProductionEnv());
  assert.equal(config.get('DATABASE_URL'), 'mysql://minewiki:strong@127.0.0.1:3306/minewiki');
  assert.equal(config.get('APP_ENCRYPTION_KEY'), 'base64-production-key');
});

function validProductionEnv() {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'mysql://minewiki:strong@127.0.0.1:3306/minewiki',
    REDIS_URL: 'redis://127.0.0.1:6379',
    NEXT_PUBLIC_SITE_URL: 'https://minewiki.kr',
    NEXT_PUBLIC_API_BASE_URL: 'https://minewiki.kr/api',
    INTERNAL_API_BASE_URL: 'http://127.0.0.1:3000',
    API_HOST: '127.0.0.1',
    API_PORT: '3000',
    VERIFY_PUBLIC_BASE_URL: 'https://minewiki.kr',
    DISCORD_BOT_TOKEN: 'discord-bot-token',
    DISCORD_CLIENT_ID: 'discord-client-id',
    DISCORD_CLIENT_SECRET: 'discord-client-secret',
    DISCORD_REDIRECT_URI: 'https://minewiki.kr/auth/callback/discord',
    INTERNAL_BOT_API_TOKEN: 'internal-bot-token',
    PLUGIN_SYNC_TOKEN: 'plugin-sync-token',
    MICROSOFT_CLIENT_ID: 'microsoft-client-id',
    MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
    MICROSOFT_REDIRECT_URI: 'https://minewiki.kr/minecraft/callback',
    NAVER_CLIENT_ID: 'naver-client-id',
    NAVER_CLIENT_SECRET: 'naver-client-secret',
    NAVER_REDIRECT_URI: 'https://minewiki.kr/auth/callback/naver',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    UPLOAD_STORAGE_ROOT: '/var/www/MineWiki/apps/cdn/storage',
    STORAGE_PUBLIC_BASE_URL: 'https://minewiki.kr/uploads',
    SMTP_HOST: 'smtp.example.com',
    SMTP_FROM: 'MineWiki <no-reply@minewiki.kr>',
    APP_ENCRYPTION_KEY: 'base64-production-key'
  };
}
