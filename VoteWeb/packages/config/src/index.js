"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigService = void 0;
const dotenv_1 = require("dotenv");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const zod_1 = require("zod");
let environmentLoaded = false;
function hydrateEnvironment() {
    if (environmentLoaded) {
        return;
    }
    const customEnvFile = process.env.CREEPERVOTE_ENV_FILE?.trim();
    const defaultFiles = ['.env.local', '.env'];
    const candidates = [
        ...(customEnvFile ? [customEnvFile] : []),
        ...defaultFiles
    ];
    for (const fileName of candidates) {
        const absolutePath = (0, node_path_1.resolve)(process.cwd(), fileName);
        if (!(0, node_fs_1.existsSync)(absolutePath)) {
            continue;
        }
        (0, dotenv_1.config)({ path: absolutePath, override: false });
    }
    environmentLoaded = true;
}
hydrateEnvironment();
const envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: zod_1.z.coerce.number().int().positive().optional(),
    API_HOST: zod_1.z.string().optional(),
    NEXT_PUBLIC_API_BASE_URL: zod_1.z.string().url().optional(),
    REDIS_URL: zod_1.z.string().url().optional(),
    DISCORD_BOT_TOKEN: zod_1.z.string().optional(),
    DISCORD_CLIENT_ID: zod_1.z.string().optional(),
    DISCORD_CLIENT_SECRET: zod_1.z.string().optional(),
    DISCORD_REDIRECT_URI: zod_1.z.string().url().optional(),
    TURNSTILE_SECRET_KEY: zod_1.z.string().optional(),
    HCAPTCHA_SECRET_KEY: zod_1.z.string().optional(),
    UPLOAD_STORAGE_ROOT: zod_1.z.string().optional(),
    ACCOUNT_LINKING_ENABLED: zod_1.z.string().optional(),
    SENTRY_DSN: zod_1.z.string().url().optional(),
    MICROSOFT_CLIENT_ID: zod_1.z.string().optional(),
    MICROSOFT_CLIENT_SECRET: zod_1.z.string().optional(),
    MICROSOFT_REDIRECT_URI: zod_1.z.string().url().optional(),
    NAVER_CLIENT_ID: zod_1.z.string().optional(),
    NAVER_CLIENT_SECRET: zod_1.z.string().optional(),
    NAVER_REDIRECT_URI: zod_1.z.string().url().optional(),
    OBSERVABILITY_ENDPOINT: zod_1.z.string().url().optional(),
    OBSERVABILITY_API_KEY: zod_1.z.string().optional()
});
class ConfigService {
    constructor(source = process.env) {
        this.env = envSchema.parse(source);
    }
    get(key, fallback) {
        const value = this.env[key];
        if (value === undefined || value === null || value === '') {
            if (fallback !== undefined) {
                return fallback;
            }
            throw new Error(`Configuration key ${String(key)} is missing`);
        }
        return value;
    }
    getOptional(key) {
        const value = this.env[key];
        if (value === undefined || value === null || value === '') {
            return undefined;
        }
        return value;
    }
    getNumber(key, fallback) {
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
exports.ConfigService = ConfigService;
//# sourceMappingURL=index.js.map