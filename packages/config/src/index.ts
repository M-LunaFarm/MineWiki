import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

let environmentLoaded = false;

function hydrateEnvironment(): void {
  if (environmentLoaded) {
    return;
  }

  const customEnvFile =
    process.env.MINEWIKI_ENV_FILE?.trim() ?? process.env.CREEPERVOTE_ENV_FILE?.trim();
  const defaultFiles = ['.env.local', '.env'];
  const candidates = [
    ...(customEnvFile ? [customEnvFile] : []),
    ...defaultFiles
  ];

  for (const fileName of candidates) {
    const absolutePath = resolve(process.cwd(), fileName);
    if (!existsSync(absolutePath)) {
      continue;
    }

    loadEnv({ path: absolutePath, override: false });
  }

  environmentLoaded = true;
}

hydrateEnvironment();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().optional(),
  API_HOST: z.string().optional(),
  NEXT_PUBLIC_API_BASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
  INTERNAL_API_BASE_URL: z.string().url().optional(),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().url().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  DISCORD_REDIRECT_URI: z.string().url().optional(),
  INTERNAL_BOT_API_TOKEN: z.string().optional(),
  PLUGIN_SYNC_TOKEN: z.string().optional(),
  VERIFY_PUBLIC_BASE_URL: z.string().url().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  HCAPTCHA_SECRET_KEY: z.string().optional(),
  UPLOAD_STORAGE_ROOT: z.string().optional(),
  ACCOUNT_LINKING_ENABLED: z.string().optional(),
  SENTRY_DSN: z.string().url().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_REDIRECT_URI: z.string().url().optional(),
  NAVER_CLIENT_ID: z.string().optional(),
  NAVER_CLIENT_SECRET: z.string().optional(),
  NAVER_REDIRECT_URI: z.string().url().optional(),
  OBSERVABILITY_ENDPOINT: z.string().url().optional(),
  OBSERVABILITY_API_KEY: z.string().optional(),
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_REGION: z.string().optional(),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),
  STORAGE_PUBLIC_BASE_URL: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z.string().optional(),
  SMTP_FROM: z.string().optional()
});

type EnvSchema = z.infer<typeof envSchema>;

type NumericEnvKey = {
  [Key in keyof EnvSchema]: EnvSchema[Key] extends number | undefined ? Key : never;
}[keyof EnvSchema];

export class ConfigService {
  private readonly env: EnvSchema;

  constructor(source: NodeJS.ProcessEnv = process.env) {
    this.env = envSchema.parse(source);
  }

  get<Key extends keyof EnvSchema>(
    key: Key,
    fallback?: EnvSchema[Key]
  ): NonNullable<EnvSchema[Key]> {
    const value = this.env[key];
    if (value === undefined || value === null || value === '') {
      if (fallback !== undefined) {
        return fallback as NonNullable<EnvSchema[Key]>;
      }
      throw new Error(`Configuration key ${String(key)} is missing`);
    }
    return value as NonNullable<EnvSchema[Key]>;
  }

  getOptional<Key extends keyof EnvSchema>(key: Key): EnvSchema[Key] | undefined {
    const value = this.env[key];
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    return value as EnvSchema[Key];
  }

  getNumber(key: NumericEnvKey, fallback?: number): number {
    const raw = this.env[key];
    if (typeof raw === 'number') {
      return raw;
    }
    if (raw === undefined || raw === null || raw === '') {
      if (fallback !== undefined) {
        return fallback;
      }
      throw new Error(`Configuration key ${String(key)} is missing`);
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
      throw new Error(`Configuration key ${String(key)} is not a valid number`);
    }
    return parsed;
  }
}
