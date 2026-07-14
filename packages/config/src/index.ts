import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export { assertSupportedQueueServer } from './redis-compat';

let environmentLoaded = false;

function hydrateEnvironment(): void {
  if (environmentLoaded) {
    return;
  }

  const customEnvFile = process.env.MINEWIKI_ENV_FILE?.trim();
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

const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().url().optional()
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MINEWIKI_SERVICE: z.enum(['all', 'api', 'worker', 'bot', 'migration']).default('all'),
  API_PORT: z.coerce.number().int().positive().optional(),
  API_HOST: z.string().optional(),
  NEXT_PUBLIC_API_BASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
  NEXT_PUBLIC_MAIN_SITE_URL: z.string().url().optional(),
  NEXT_PUBLIC_VERIFY_URL: z.string().url().optional(),
  INTERNAL_API_BASE_URL: z.string().url().optional(),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().url().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  DISCORD_REDIRECT_URI: optionalUrl,
  INTERNAL_BOT_API_TOKEN: z.string().optional(),
  PLUGIN_SYNC_TOKEN: z.string().optional(),
  VERIFY_PUBLIC_BASE_URL: z.string().url().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  HCAPTCHA_SECRET_KEY: z.string().optional(),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().optional(),
  NEXT_PUBLIC_HCAPTCHA_SITE_KEY: z.string().optional(),
  UPLOAD_STORAGE_ROOT: z.string().optional(),
  ACCOUNT_LINKING_ENABLED: z.string().optional(),
  APP_ENCRYPTION_KEY: z.string().optional(),
  SENTRY_DSN: optionalUrl,
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_REDIRECT_URI: optionalUrl,
  NAVER_CLIENT_ID: z.string().optional(),
  NAVER_CLIENT_SECRET: z.string().optional(),
  NAVER_REDIRECT_URI: optionalUrl,
  OBSERVABILITY_ENDPOINT: optionalUrl,
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

const commonProductionKeys: Array<keyof EnvSchema> = [
  'DATABASE_URL',
  'REDIS_URL',
];

const apiProductionKeys: Array<keyof EnvSchema> = [
  ...commonProductionKeys,
  'NEXT_PUBLIC_SITE_URL',
  'NEXT_PUBLIC_API_BASE_URL',
  'INTERNAL_API_BASE_URL',
  'API_HOST',
  'API_PORT',
  'VERIFY_PUBLIC_BASE_URL',
  'INTERNAL_BOT_API_TOKEN',
  'PLUGIN_SYNC_TOKEN',
  'STORAGE_PUBLIC_BASE_URL',
  'SMTP_HOST',
  'SMTP_FROM',
  'APP_ENCRYPTION_KEY',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_REDIRECT_URI'
];

const botProductionKeys: Array<keyof EnvSchema> = [
  ...commonProductionKeys,
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'INTERNAL_BOT_API_TOKEN',
  'INTERNAL_API_BASE_URL'
];

const workerProductionKeys: Array<keyof EnvSchema> = [
  ...commonProductionKeys,
  'APP_ENCRYPTION_KEY',
  'INTERNAL_API_BASE_URL',
];

const productionStorageKeys: Array<keyof EnvSchema> = [
  'STORAGE_REGION',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY'
];

const unsafePlaceholderValues = new Set([
  'change-me',
  'changeme',
  'replace-me',
  'todo',
  'secret',
  'password'
]);

type NumericEnvKey = {
  [Key in keyof EnvSchema]: EnvSchema[Key] extends number | undefined ? Key : never;
}[keyof EnvSchema];

export class ConfigService {
  private readonly env: EnvSchema;

  constructor(source: NodeJS.ProcessEnv = process.env) {
    this.env = envSchema.parse(source);
    validateProductionEnvironment(this.env);
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

function validateProductionEnvironment(env: EnvSchema): void {
  if (env.NODE_ENV !== 'production') {
    return;
  }

  const failures: string[] = [];
  const requiredKeys = resolveRequiredKeys(env.MINEWIKI_SERVICE);
  for (const key of requiredKeys) {
    const value = env[key];
    if (isBlank(value)) {
      failures.push(`${String(key)} is required`);
      continue;
    }
    if (containsUnsafePlaceholder(value)) {
      failures.push(`${String(key)} still contains a placeholder value`);
    }
  }

  if (env.MINEWIKI_SERVICE === 'api' || env.MINEWIKI_SERVICE === 'all') {
    validateCaptchaConfiguration(env, failures);
    validateOptionalGroup(
      env,
      ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI'],
      'Discord OAuth',
      failures
    );
    validateOptionalGroup(
      env,
      ['NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET', 'NAVER_REDIRECT_URI'],
      'NAVER OAuth',
      failures
    );
    validateMicrosoftRedirectUri(env, failures);
    validateOptionalGroup(env, ['SMTP_USER', 'SMTP_PASS'], 'SMTP authentication', failures);
  }

  if (env.MINEWIKI_SERVICE === 'api' || env.MINEWIKI_SERVICE === 'all') {
    if (!isBlank(env.STORAGE_BUCKET)) {
      for (const key of productionStorageKeys) {
        if (isBlank(env[key])) {
          failures.push(`${String(key)} is required when STORAGE_BUCKET is set`);
        }
      }
    } else if (isBlank(env.UPLOAD_STORAGE_ROOT)) {
      failures.push('UPLOAD_STORAGE_ROOT is required when STORAGE_BUCKET is not set');
    }
  }

  if (failures.length > 0) {
    throw new Error(`Production configuration is incomplete: ${failures.join('; ')}`);
  }
}

function validateMicrosoftRedirectUri(env: EnvSchema, failures: string[]): void {
  if (isBlank(env.MICROSOFT_REDIRECT_URI) || isBlank(env.VERIFY_PUBLIC_BASE_URL)) {
    return;
  }
  const expected = new URL('/minecraft/callback', env.VERIFY_PUBLIC_BASE_URL).toString();
  if (env.MICROSOFT_REDIRECT_URI !== expected) {
    failures.push(`MICROSOFT_REDIRECT_URI must be ${expected}`);
  }
}

function resolveRequiredKeys(service: EnvSchema['MINEWIKI_SERVICE']): Array<keyof EnvSchema> {
  switch (service) {
    case 'api':
      return apiProductionKeys;
    case 'worker':
      return workerProductionKeys;
    case 'bot':
      return botProductionKeys;
    case 'migration':
      return ['DATABASE_URL'];
    case 'all':
    default:
      return Array.from(new Set([...apiProductionKeys, ...botProductionKeys]));
  }
}

function validateCaptchaConfiguration(env: EnvSchema, failures: string[]): void {
  const turnstileConfigured =
    !isBlank(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) || !isBlank(env.TURNSTILE_SECRET_KEY);
  const hcaptchaConfigured =
    !isBlank(env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY) || !isBlank(env.HCAPTCHA_SECRET_KEY);

  if (!turnstileConfigured && !hcaptchaConfigured) {
    failures.push('a complete Turnstile or hCaptcha configuration is required');
    return;
  }
  if (turnstileConfigured) {
    validateRequiredGroup(
      env,
      ['NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'],
      'Turnstile',
      failures
    );
  }
  if (hcaptchaConfigured) {
    validateRequiredGroup(
      env,
      ['NEXT_PUBLIC_HCAPTCHA_SITE_KEY', 'HCAPTCHA_SECRET_KEY'],
      'hCaptcha',
      failures
    );
  }
}

function validateOptionalGroup(
  env: EnvSchema,
  keys: Array<keyof EnvSchema>,
  label: string,
  failures: string[]
): void {
  if (keys.every((key) => isBlank(env[key]))) {
    return;
  }
  validateRequiredGroup(env, keys, label, failures);
}

function validateRequiredGroup(
  env: EnvSchema,
  keys: Array<keyof EnvSchema>,
  label: string,
  failures: string[]
): void {
  for (const key of keys) {
    if (isBlank(env[key])) {
      failures.push(`${String(key)} is required when ${label} is configured`);
    } else if (containsUnsafePlaceholder(env[key])) {
      failures.push(`${String(key)} still contains a placeholder value`);
    }
  }
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function containsUnsafePlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (unsafePlaceholderValues.has(normalized)) {
    return true;
  }
  return normalized.includes('change-me') || normalized.includes('replace-me');
}
