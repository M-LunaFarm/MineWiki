const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const envFile = path.join(repoRoot, '.env');

module.exports = {
  apps: [
    {
      name: 'minewiki-web',
      cwd: path.join(repoRoot, 'apps/web'),
      script: 'node_modules/next/dist/bin/next',
      args: 'start -H 127.0.0.1 -p 4311',
      env: {
        NODE_ENV: 'production',
        PORT: '4311',
        MINEWIKI_ENV_FILE: envFile,
      },
    },
    {
      name: 'minewiki-api',
      cwd: path.join(repoRoot, 'apps/api'),
      script: 'dist/apps/api/src/main.js',
      env: {
        NODE_ENV: 'production',
        MINEWIKI_SERVICE: 'api',
        API_HOST: '127.0.0.1',
        API_PORT: '3000',
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
        MINEWIKI_ENV_FILE: envFile,
      },
    },
  ],
};
