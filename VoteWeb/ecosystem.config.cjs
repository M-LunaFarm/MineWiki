module.exports = {
  apps: [
    {
      name: 'creepervote-api',
      cwd: 'apps/api',
      script: 'npm',
      args: 'start',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'creepervote-web',
      cwd: 'apps/web',
      script: 'npm',
      args: 'start',
      env: {
        NODE_ENV: 'production',
        PORT: '3000'
      }
    },
    {
      name: 'creepervote-worker',
      cwd: 'apps/worker',
      script: 'npm',
      args: 'start',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'creepervote-bot',
      cwd: 'apps/bot',
      script: 'npm',
      args: 'start',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'creepervote-cdn',
      cwd: 'apps/cdn',
      script: 'npm',
      args: 'start',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
