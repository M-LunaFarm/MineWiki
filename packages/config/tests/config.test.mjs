import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService, assertSupportedQueueServer } from '../dist/index.js';

test('queue backend validation accepts Redis 7 and rejects incompatible servers', () => {
  assert.doesNotThrow(() =>
    assertSupportedQueueServer('redis_version:7.4.2\r\nredis_mode:standalone\r\n'),
  );
  assert.throws(
    () => assertSupportedQueueServer('redis_version:7.0.0\r\ndragonfly_version:1.30.3\r\n'),
    /Dragonfly is not supported/,
  );
  assert.throws(() => assertSupportedQueueServer('redis_version:6.2.14\r\n'), /Redis 7 or newer/);
});

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

test('API production config allows optional login OAuth integrations to be absent', () => {
  const source = validProductionEnv();
  source.MINEWIKI_SERVICE = 'api';
  delete source.DISCORD_BOT_TOKEN;
  delete source.DISCORD_CLIENT_ID;
  delete source.DISCORD_CLIENT_SECRET;
  delete source.DISCORD_REDIRECT_URI;
  delete source.NAVER_CLIENT_ID;
  delete source.NAVER_CLIENT_SECRET;
  delete source.NAVER_REDIRECT_URI;

  const config = new ConfigService(source);
  assert.equal(config.get('MINEWIKI_SERVICE'), 'api');
});

test('API production config accepts blank optional login OAuth groups', () => {
  const source = validProductionEnv();
  source.MINEWIKI_SERVICE = 'api';
  source.DISCORD_CLIENT_ID = '';
  source.DISCORD_CLIENT_SECRET = '';
  source.DISCORD_REDIRECT_URI = '';
  source.NAVER_CLIENT_ID = '';
  source.NAVER_CLIENT_SECRET = '';
  source.NAVER_REDIRECT_URI = '';

  const config = new ConfigService(source);
  assert.equal(config.get('MINEWIKI_SERVICE'), 'api');
});

test('API production config requires Microsoft ownership verification', () => {
  const source = validProductionEnv();
  source.MINEWIKI_SERVICE = 'api';
  delete source.MICROSOFT_CLIENT_SECRET;

  assert.throws(
    () => new ConfigService(source),
    /MICROSOFT_CLIENT_SECRET is required/
  );
});

test('API production config rejects Microsoft callback outside the official service', () => {
  const source = validProductionEnv();
  source.MINEWIKI_SERVICE = 'api';
  source.MICROSOFT_REDIRECT_URI = 'https://lunaf.kr/minecraft/callback';

  assert.throws(
    () => new ConfigService(source),
    /MICROSOFT_REDIRECT_URI must be https:\/\/verify\.minewiki\.kr\/minecraft\/callback/
  );
});

test('API production config rejects a partial OAuth integration', () => {
  const source = validProductionEnv();
  source.MINEWIKI_SERVICE = 'api';
  delete source.NAVER_CLIENT_SECRET;

  assert.throws(
    () => new ConfigService(source),
    /NAVER_CLIENT_SECRET is required when NAVER OAuth is configured/
  );
});

test('API production config requires matching captcha site and secret keys', () => {
  const source = validProductionEnv();
  source.MINEWIKI_SERVICE = 'api';
  delete source.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  assert.throws(
    () => new ConfigService(source),
    /NEXT_PUBLIC_TURNSTILE_SITE_KEY is required when Turnstile is configured/
  );
});

test('bot production config only requires bot runtime dependencies', () => {
  const config = new ConfigService({
    NODE_ENV: 'production',
    MINEWIKI_SERVICE: 'bot',
    DATABASE_URL: 'mysql://minewiki:strong@mysql:3306/minewiki',
    REDIS_URL: 'redis://redis:6379',
    DISCORD_BOT_TOKEN: 'discord-bot-token',
    DISCORD_CLIENT_ID: 'discord-client-id',
    INTERNAL_BOT_API_TOKEN: 'internal-bot-token',
    INTERNAL_API_BASE_URL: 'http://api:3000'
  });
  assert.equal(config.get('MINEWIKI_SERVICE'), 'bot');
});

test('worker production config requires the credential encryption key', () => {
  const source = {
    NODE_ENV: 'production',
    MINEWIKI_SERVICE: 'worker',
    DATABASE_URL: 'mysql://minewiki:strong@mysql:3306/minewiki',
    REDIS_URL: 'redis://redis:6379',
    INTERNAL_API_BASE_URL: 'http://api:3000'
  };
  assert.throws(() => new ConfigService(source), /APP_ENCRYPTION_KEY is required/);
  const config = new ConfigService({ ...source, APP_ENCRYPTION_KEY: 'worker-encryption-key' });
  assert.equal(config.get('MINEWIKI_SERVICE'), 'worker');
});

test('worker production config requires the account lifecycle API address', () => {
  const source = {
    NODE_ENV: 'production',
    MINEWIKI_SERVICE: 'worker',
    DATABASE_URL: 'mysql://minewiki:strong@mysql:3306/minewiki',
    REDIS_URL: 'redis://redis:6379',
    APP_ENCRYPTION_KEY: 'worker-encryption-key'
  };
  assert.throws(() => new ConfigService(source), /INTERNAL_API_BASE_URL is required/);
});

function validProductionEnv() {
  return {
    NODE_ENV: 'production',
    MINEWIKI_SERVICE: 'all',
    DATABASE_URL: 'mysql://minewiki:strong@127.0.0.1:3306/minewiki',
    REDIS_URL: 'redis://127.0.0.1:6379',
    NEXT_PUBLIC_SITE_URL: 'https://minewiki.kr',
    NEXT_PUBLIC_MAIN_SITE_URL: 'https://minewiki.kr',
    NEXT_PUBLIC_VERIFY_URL: 'https://verify.minewiki.kr',
    NEXT_PUBLIC_API_BASE_URL: 'https://minewiki.kr/api',
    INTERNAL_API_BASE_URL: 'http://127.0.0.1:3000',
    API_HOST: '127.0.0.1',
    API_PORT: '3000',
    VERIFY_PUBLIC_BASE_URL: 'https://verify.minewiki.kr',
    DISCORD_BOT_TOKEN: 'discord-bot-token',
    DISCORD_CLIENT_ID: 'discord-client-id',
    DISCORD_CLIENT_SECRET: 'discord-client-secret',
    DISCORD_REDIRECT_URI: 'https://minewiki.kr/auth/callback/discord',
    INTERNAL_BOT_API_TOKEN: 'internal-bot-token',
    PLUGIN_SYNC_TOKEN: 'plugin-sync-token',
    MICROSOFT_CLIENT_ID: 'microsoft-client-id',
    MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
    MICROSOFT_REDIRECT_URI: 'https://verify.minewiki.kr/minecraft/callback',
    NAVER_CLIENT_ID: 'naver-client-id',
    NAVER_CLIENT_SECRET: 'naver-client-secret',
    NAVER_REDIRECT_URI: 'https://minewiki.kr/auth/callback/naver',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'turnstile-site-key',
    UPLOAD_STORAGE_ROOT: '/var/www/MineWiki/storage/uploads',
    STORAGE_PUBLIC_BASE_URL: 'https://minewiki.kr/uploads',
    SMTP_HOST: 'smtp.example.com',
    SMTP_FROM: 'MineWiki <no-reply@minewiki.kr>',
    APP_ENCRYPTION_KEY: 'base64-production-key'
  };
}
