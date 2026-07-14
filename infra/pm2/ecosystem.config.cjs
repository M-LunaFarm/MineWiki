const path = require('node:path');
const fs = require('node:fs');
const { parse: parseDotenv } = require('dotenv');

const repoRoot = path.resolve(__dirname, '../..');
const envFile = process.env.MINEWIKI_ENV_FILE?.trim() || path.join(repoRoot, '.env');
const fileEnv = fs.existsSync(envFile) ? parseDotenv(fs.readFileSync(envFile)) : {};

function configValue(name, fallback) {
  return process.env[name]?.trim() || fileEnv[name]?.trim() || fallback;
}

const webPort = '4320';
const verifyWebPort = '4322';
const apiPort = '4321';
const internalApiBaseUrl = `http://127.0.0.1:${apiPort}`;

module.exports = {
  apps: [
    {
      name: 'minewiki-web',
      cwd: path.join(repoRoot, 'apps/web'),
      script: 'node_modules/next/dist/bin/next',
      args: `start -H 127.0.0.1 -p ${webPort}`,
      env: {
        NODE_ENV: 'production',
        PORT: webPort,
        MINEWIKI_ENV_FILE: envFile,
        INTERNAL_API_BASE_URL: internalApiBaseUrl,
        NEXT_PUBLIC_API_BASE_URL: configValue(
          'NEXT_PUBLIC_API_BASE_URL',
          'https://minewiki.kr/api',
        ),
        NEXT_PUBLIC_SITE_URL: configValue('NEXT_PUBLIC_SITE_URL', 'https://minewiki.kr'),
        NEXT_PUBLIC_MAIN_SITE_URL: configValue(
          'NEXT_PUBLIC_MAIN_SITE_URL',
          'https://minewiki.kr',
        ),
        NEXT_PUBLIC_VERIFY_URL: configValue(
          'NEXT_PUBLIC_VERIFY_URL',
          'https://verify.minewiki.kr',
        ),
      },
    },
    {
      name: 'minewiki-verify-web',
      cwd: path.join(repoRoot, 'apps/web'),
      script: 'node_modules/next/dist/bin/next',
      args: `start -H 127.0.0.1 -p ${verifyWebPort}`,
      env: {
        NODE_ENV: 'production',
        PORT: verifyWebPort,
        MINEWIKI_ENV_FILE: envFile,
        INTERNAL_API_BASE_URL: internalApiBaseUrl,
        NEXT_PUBLIC_API_BASE_URL: configValue(
          'NEXT_PUBLIC_API_BASE_URL',
          'https://minewiki.kr/api',
        ),
        NEXT_PUBLIC_SITE_URL: configValue(
          'NEXT_PUBLIC_VERIFY_URL',
          'https://verify.minewiki.kr',
        ),
        NEXT_PUBLIC_MAIN_SITE_URL: configValue(
          'NEXT_PUBLIC_MAIN_SITE_URL',
          'https://minewiki.kr',
        ),
        NEXT_PUBLIC_VERIFY_URL: configValue(
          'NEXT_PUBLIC_VERIFY_URL',
          'https://verify.minewiki.kr',
        ),
      },
    },
    {
      name: 'minewiki-api',
      cwd: path.join(repoRoot, 'apps/api'),
      script: 'dist/apps/api/src/main.js',
      wait_ready: true,
      listen_timeout: 15000,
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        MINEWIKI_SERVICE: 'api',
        API_HOST: '127.0.0.1',
        API_PORT: apiPort,
        INTERNAL_API_BASE_URL: internalApiBaseUrl,
        MINEWIKI_ENV_FILE: envFile,
      },
    },
    {
      name: 'minewiki-worker',
      cwd: path.join(repoRoot, 'apps/worker'),
      script: 'dist/apps/worker/src/index.js',
      env: {
        NODE_ENV: 'production',
        MINEWIKI_SERVICE: 'worker',
        MINEWIKI_ENV_FILE: envFile,
      },
    },
    {
      name: 'minewiki-bot',
      cwd: path.join(repoRoot, 'apps/bot'),
      script: 'dist/apps/bot/src/index.js',
      env: {
        NODE_ENV: 'production',
        MINEWIKI_SERVICE: 'bot',
        INTERNAL_API_BASE_URL: internalApiBaseUrl,
        MINEWIKI_ENV_FILE: envFile,
      },
    },
  ],
};
