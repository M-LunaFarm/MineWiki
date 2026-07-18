import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { ConfigService, assertSupportedQueueServer } from '../dist/index.js';

const vapidEcdh = createECDH('prime256v1');
vapidEcdh.generateKeys();
const TEST_VAPID_PUBLIC_KEY = vapidEcdh.getPublicKey().toString('base64url');
const TEST_VAPID_PRIVATE_KEY = vapidEcdh.getPrivateKey().toString('base64url');

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

test('anonymous wiki edit requests require a dedicated private hash key and matching public UI flag', () => {
  const enabled = validProductionEnv();
  enabled.WIKI_ANONYMOUS_EDIT_REQUESTS_ENABLED = 'true';
  assert.throws(() => new ConfigService(enabled), /WIKI_ANONYMOUS_IP_HASH_SECRET is required/);
  enabled.WIKI_ANONYMOUS_IP_HASH_SECRET = 'dedicated-anonymous-ip-secret';
  assert.throws(() => new ConfigService(enabled), /NEXT_PUBLIC_WIKI_ANONYMOUS_EDIT_REQUESTS_ENABLED must be true/);
  enabled.NEXT_PUBLIC_WIKI_ANONYMOUS_EDIT_REQUESTS_ENABLED = 'true';
  assert.doesNotThrow(() => new ConfigService(enabled));
});

test('Paddle shadow mode requires a webhook secret only when enabled', () => {
  const disabled = validProductionEnv();
  disabled.PADDLE_MODE = 'off';
  assert.doesNotThrow(() => new ConfigService(disabled));

  const shadow = validProductionEnv();
  shadow.PADDLE_MODE = 'shadow';
  assert.throws(() => new ConfigService(shadow), /PADDLE_WEBHOOK_SECRET is required/);
  shadow.PADDLE_WEBHOOK_SECRET = 'paddle-endpoint-secret';
  assert.equal(new ConfigService(shadow).get('PADDLE_MODE'), 'shadow');
});

test('Paddle live mode requires the complete private billing configuration', () => {
  const live = validProductionEnv();
  live.PADDLE_MODE = 'live';
  assert.throws(
    () => new ConfigService(live),
    /PADDLE_WEBHOOK_SECRET is required.*PADDLE_API_KEY is required.*PADDLE_PRICE_HANDBOOK is required.*PADDLE_PRICE_BRAND is required.*PADDLE_CHECKOUT_URL is required.*PADDLE_POLICY_VERSION is required/s,
  );

  Object.assign(live, validPaddleLiveEnv());
  const config = new ConfigService(live);
  assert.equal(config.get('PADDLE_MODE'), 'live');
  assert.equal(config.get('PADDLE_ENV'), 'sandbox');
});

test('Paddle live mode rejects a price id shared by two layouts', () => {
  const live = {
    ...validProductionEnv(),
    ...validPaddleLiveEnv(),
    PADDLE_PRICE_BRAND: 'pri_handbook',
  };
  assert.throws(() => new ConfigService(live), /PADDLE_PRICE_HANDBOOK and PADDLE_PRICE_BRAND must be distinct/);
});

test('Paddle live mode is pinned to the current billing policy contract', () => {
  const live = {
    ...validProductionEnv(),
    ...validPaddleLiveEnv(),
    PADDLE_POLICY_VERSION: '2026-02-17-v1.0',
  };
  assert.throws(() => new ConfigService(live), /PADDLE_POLICY_VERSION must equal 2026-07-19-v2.0/);
});

test('WebAuthn config requires an exact validated origin and related RP ID', () => {
  assert.throws(
    () => new ConfigService({ WEBAUTHN_ORIGIN: 'https://login.minewiki.kr' }),
    /must be configured together/,
  );
  assert.throws(
    () => new ConfigService({
      WEBAUTHN_ORIGIN: 'https://evil.example',
      WEBAUTHN_RP_ID: 'minewiki.kr',
    }),
    /must equal or be a subdomain/,
  );
  assert.throws(
    () => new ConfigService({
      WEBAUTHN_ORIGIN: 'https://minewiki.kr/auth',
      WEBAUTHN_RP_ID: 'minewiki.kr',
    }),
    /only scheme, host/,
  );
  assert.doesNotThrow(() => new ConfigService({
    WEBAUTHN_ORIGIN: 'http://localhost:8080',
    WEBAUTHN_RP_ID: 'localhost',
  }));
  const derived = new ConfigService({ NEXT_PUBLIC_SITE_URL: 'https://login.minewiki.kr/path' });
  assert.equal(derived.get('WEBAUTHN_ORIGIN'), 'https://login.minewiki.kr');
  assert.equal(derived.get('WEBAUTHN_RP_ID'), 'login.minewiki.kr');
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

test('Web Push remains optional until explicitly enabled', () => {
  const source = validProductionEnv();
  source.WEB_PUSH_ENABLED = 'false';
  assert.doesNotThrow(() => new ConfigService(source));
});

test('API Web Push requires only the public VAPID key', () => {
  const source = validProductionEnv();
  source.MINEWIKI_SERVICE = 'api';
  source.WEB_PUSH_ENABLED = 'true';
  delete source.VAPID_PUBLIC_KEY;
  assert.throws(() => new ConfigService(source), /VAPID_PUBLIC_KEY is required/);

  source.VAPID_PUBLIC_KEY = TEST_VAPID_PUBLIC_KEY;
  assert.doesNotThrow(() => new ConfigService(source));
  source.VAPID_PUBLIC_KEY = 'not-a-public-key';
  assert.throws(() => new ConfigService(source), /uncompressed P-256 public key/);
});

test('worker Web Push requires the complete private VAPID configuration', () => {
  const source = {
    NODE_ENV: 'production',
    MINEWIKI_SERVICE: 'worker',
    DATABASE_URL: 'mysql://minewiki:strong@mysql:3306/minewiki',
    REDIS_URL: 'redis://redis:6379',
    INTERNAL_API_BASE_URL: 'http://api:3000',
    APP_ENCRYPTION_KEY: 'worker-encryption-key',
    WEB_PUSH_ENABLED: 'true',
    VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
  };
  assert.throws(() => new ConfigService(source), /VAPID_PRIVATE_KEY is required/);
  assert.doesNotThrow(() => new ConfigService({
    ...source,
    VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: 'mailto:support@minewiki.kr',
  }));
  const otherKey = createECDH('prime256v1');
  otherKey.generateKeys();
  assert.throws(() => new ConfigService({
    ...source,
    VAPID_PRIVATE_KEY: otherKey.getPrivateKey().toString('base64url'),
    VAPID_SUBJECT: 'mailto:support@minewiki.kr',
  }), /VAPID public and private keys do not match/);
  assert.throws(() => new ConfigService({
    ...source,
    VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: 'javascript:alert(1)',
  }), /VAPID_SUBJECT must be/);
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
    WEBAUTHN_ORIGIN: 'https://minewiki.kr',
    WEBAUTHN_RP_ID: 'minewiki.kr',
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

function validPaddleLiveEnv() {
  return {
    PADDLE_MODE: 'live',
    PADDLE_ENV: 'sandbox',
    PADDLE_WEBHOOK_SECRET: 'paddle-endpoint-secret',
    PADDLE_API_KEY: 'paddle-api-key',
    PADDLE_PRICE_HANDBOOK: 'pri_handbook',
    PADDLE_PRICE_BRAND: 'pri_brand',
    PADDLE_CHECKOUT_URL: 'https://minewiki.kr/server/billing/checkout',
    PADDLE_POLICY_VERSION: '2026-07-19-v2.0',
  };
}
