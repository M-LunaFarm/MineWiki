#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArgs(process.argv.slice(2));
const targetPath = path.resolve(rootDir, options.target);

if (options.help) {
  printHelp();
  process.exit(0);
}
if (existsSync(targetPath) && !options.force) {
  console.error(`Refusing to overwrite existing environment file: ${targetPath}`);
  process.exit(1);
}

const legacy = await readEnvironment(options.legacyEnv, 'legacy VoteWeb environment');
const mail = await readEnvironment(options.mailEnv, 'mail environment');
const requiredLegacyKeys = [
  'DATABASE_URL',
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
];
const missing = requiredLegacyKeys.filter((key) => !legacy[key]?.trim());
if (!mail.GMAIL_USERNAME?.trim() || !mail.GMAIL_APP_PASSWORD?.trim()) {
  missing.push('GMAIL_USERNAME/GMAIL_APP_PASSWORD');
}
if (missing.length > 0) {
  console.error(`Cannot prepare production environment; missing: ${missing.join(', ')}`);
  process.exit(1);
}

const values = {
  NODE_ENV: 'production',
  MINEWIKI_ENV_FILE: targetPath,
  NEXT_PUBLIC_SITE_URL: 'https://minewiki.kr',
  NEXT_PUBLIC_MAIN_SITE_URL: 'https://minewiki.kr',
  NEXT_PUBLIC_VERIFY_URL: 'https://verify.minewiki.kr',
  NEXT_PUBLIC_API_BASE_URL: 'https://minewiki.kr/api',
  WEBAUTHN_ORIGIN: 'https://minewiki.kr',
  WEBAUTHN_RP_ID: 'minewiki.kr',
  INTERNAL_API_BASE_URL: 'http://127.0.0.1:4321',
  API_HOST: '127.0.0.1',
  API_PORT: '4321',
  DATABASE_URL: legacy.DATABASE_URL,
  REDIS_URL: options.redisUrl,
  VERIFY_PUBLIC_BASE_URL: 'https://verify.minewiki.kr',
  APP_ENCRYPTION_KEY: generateSecret(),
  ACCOUNT_LINKING_ENABLED: legacy.ACCOUNT_LINKING_ENABLED || 'true',
  DISCORD_CLIENT_ID: legacy.DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET: legacy.DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI: 'https://minewiki.kr/auth/callback/discord',
  NAVER_CLIENT_ID: legacy.NAVER_CLIENT_ID || '',
  NAVER_CLIENT_SECRET: legacy.NAVER_CLIENT_SECRET || '',
  NAVER_REDIRECT_URI: 'https://minewiki.kr/auth/callback/naver',
  MICROSOFT_CLIENT_ID: legacy.MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET: legacy.MICROSOFT_CLIENT_SECRET,
  MICROSOFT_REDIRECT_URI: 'https://verify.minewiki.kr/minecraft/callback',
  DISCORD_BOT_TOKEN: legacy.DISCORD_BOT_TOKEN,
  INTERNAL_BOT_API_TOKEN: generateSecret(),
  PLUGIN_SYNC_TOKEN: generateSecret(),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: legacy.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '',
  TURNSTILE_SECRET_KEY: legacy.TURNSTILE_SECRET_KEY || '',
  NEXT_PUBLIC_HCAPTCHA_SITE_KEY: legacy.NEXT_PUBLIC_HCAPTCHA_SITE_KEY || '',
  HCAPTCHA_SECRET_KEY: legacy.HCAPTCHA_SECRET_KEY || '',
  UPLOAD_STORAGE_ROOT: '/var/www/MineWiki/storage/uploads',
  STORAGE_PUBLIC_BASE_URL: 'https://minewiki.kr/uploads',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ENDPOINT: '',
  STORAGE_BUCKET: '',
  STORAGE_ACCESS_KEY: '',
  STORAGE_SECRET_KEY: '',
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: '465',
  SMTP_USER: mail.GMAIL_USERNAME,
  SMTP_PASS: mail.GMAIL_APP_PASSWORD,
  SMTP_SECURE: 'true',
  SMTP_FROM: 'MineWiki <support@minewiki.kr>',
  LOG_LEVEL: legacy.LOG_LEVEL || 'info',
  SENTRY_DSN: legacy.SENTRY_DSN || '',
  OBSERVABILITY_ENDPOINT: legacy.OBSERVABILITY_ENDPOINT || '',
  OBSERVABILITY_API_KEY: legacy.OBSERVABILITY_API_KEY || '',
  SMOKE_WEB_BASE_URL: 'http://127.0.0.1:4320',
  SMOKE_API_BASE_URL: 'http://127.0.0.1:4321',
};

const output = `${Object.entries(values)
  .map(([key, value]) => `${key}=${quoteValue(value)}`)
  .join('\n')}\n`;

if (options.dryRun) {
  console.log(`Production environment is ready to write (${Object.keys(values).length} keys).`);
  process.exit(0);
}

await writeFile(targetPath, output, { encoding: 'utf8', mode: 0o600, flag: options.force ? 'w' : 'wx' });
await chmod(targetPath, 0o600);
console.log(`Production environment written with mode 0600: ${targetPath}`);
console.log('Generated encryption and internal service tokens were not printed.');

async function readEnvironment(filePath, label) {
  try {
    return parseDotenv(await readFile(path.resolve(filePath), 'utf8'));
  } catch (error) {
    console.error(`Failed to read ${label}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function generateSecret() {
  return randomBytes(48).toString('base64url');
}

function quoteValue(value) {
  return JSON.stringify(String(value ?? ''));
}

function parseArgs(argv) {
  const parsed = {
    legacyEnv: '/var/www/VoteWeb/.env',
    mailEnv: '/var/www/publicMail/.env',
    redisUrl: 'redis://127.0.0.1:16380',
    target: '.env',
    force: false,
    dryRun: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--force') parsed.force = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg.startsWith('--legacy-env=')) parsed.legacyEnv = arg.slice('--legacy-env='.length);
    else if (arg.startsWith('--mail-env=')) parsed.mailEnv = arg.slice('--mail-env='.length);
    else if (arg.startsWith('--redis-url=')) parsed.redisUrl = arg.slice('--redis-url='.length);
    else if (arg.startsWith('--target=')) parsed.target = arg.slice('--target='.length);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: pnpm env:prepare [--dry-run] [--force]

Safely creates the ignored MineWiki production .env by importing the existing
VoteWeb OAuth/database values and mail credentials, then generating fresh
encryption and internal service tokens. Secret values are never printed.

Options:
  --legacy-env=/path/to/.env
  --mail-env=/path/to/.env
  --redis-url=redis://127.0.0.1:16380
  --target=.env`);
}
