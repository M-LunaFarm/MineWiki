module.exports = {
  apps: [
    {
      name: 'minewiki-wiki',
      cwd: './apps/wiki',
      script: 'dist/src/server.js',
      env: { NODE_ENV: 'production', PORT: '3015' }
    },
    {
      name: 'minewiki-web',
      cwd: './apps/web',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -H 127.0.0.1 -p 4311',
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'minewiki-api',
      cwd: './apps/api',
      script: 'dist/apps/api/src/main.js',
      node_args: '-r module-alias/register',
      env: { NODE_ENV: 'production', PORT: '3000' }
    },
    {
      name: 'minewiki-worker',
      cwd: './apps/worker',
      script: 'dist/index.js',
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'minewiki-bot',
      cwd: './apps/bot',
      script: 'dist/index.js',
      env: { NODE_ENV: 'production' }
    }
  ]
};
