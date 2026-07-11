# MineWiki Deployment

This guide deploys the integrated MineWiki runtime from a fresh Linux server.

## Runtime Shape

Run only these active processes from `infra/pm2/ecosystem.config.cjs`:

- `minewiki-web`: Next.js frontend on `127.0.0.1:4311`
- `minewiki-api`: Nest API on `127.0.0.1:3000`
- `minewiki-worker`: BullMQ workers for pings, ranks, claims, vote dispatch, and digests
- `minewiki-bot`: Discord command and digest bot

Do not run `legacy/mwiki-fastify`.
Do not run `legacy/luna-votifier`.

## Install System Dependencies

Install Node.js 22 or newer, pnpm, MySQL, Redis, Nginx, and PM2:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get update
sudo apt-get install -y nodejs mysql-server redis-server nginx
sudo corepack enable
sudo corepack prepare pnpm@9.15.9 --activate
sudo npm install -g pm2
```

Create the database and user. Match the credentials to `DATABASE_URL`:

```sql
CREATE DATABASE minewiki CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'minewiki'@'localhost' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON minewiki.* TO 'minewiki'@'localhost';
FLUSH PRIVILEGES;
```

Start Redis and MySQL:

```bash
sudo systemctl enable --now mysql redis-server
```

## Configure Environment

Copy `.env.example` to `.env` and replace every secret and public URL:

```bash
cp .env.example .env
chmod 600 .env
```

Minimum production values:

- `DATABASE_URL=mysql://minewiki:change-me@127.0.0.1:3306/minewiki`
- `REDIS_URL=redis://127.0.0.1:6379`
- `NEXT_PUBLIC_SITE_URL=https://minewiki.kr`
- `NEXT_PUBLIC_API_BASE_URL=https://minewiki.kr/api`
- `INTERNAL_API_BASE_URL=http://127.0.0.1:3000`
- `API_HOST=127.0.0.1`
- `API_PORT=3000`
- OAuth, Discord, CAPTCHA, upload storage, mail, and plugin sync secrets

## Install And Build

```bash
pnpm install --frozen-lockfile
pnpm exec prisma generate
pnpm exec prisma migrate deploy
pnpm seed
pnpm data:validate
pnpm build
```

If `pnpm data:validate` reports only safe warnings for expired replay guards or missing render cache, run:

```bash
pnpm data:validate -- --fix
```

## Start PM2

```bash
pm2 startOrReload infra/pm2/ecosystem.config.cjs --update-env
pm2 save
pm2 status
```

Expected processes:

```text
minewiki-web
minewiki-api
minewiki-worker
minewiki-bot
```

Use logs during the first boot:

```bash
pm2 logs minewiki-api
pm2 logs minewiki-web
pm2 logs minewiki-worker
pm2 logs minewiki-bot
```

## Configure Nginx

Install the supplied route config and reload Nginx:

```bash
sudo cp infra/nginx/minewiki.conf /etc/nginx/sites-available/minewiki.conf
sudo ln -sfn /etc/nginx/sites-available/minewiki.conf /etc/nginx/sites-enabled/minewiki.conf
sudo nginx -t
sudo systemctl reload nginx
```

The important routing behavior is:

- `/api/health` proxies to `http://127.0.0.1:3000/api/health`
- `/api/*` strips `/api/` and proxies to `http://127.0.0.1:3000/*`
- everything else proxies to `http://127.0.0.1:4311`

Install TLS with your certificate manager, for example Certbot, and reload Nginx.

## Smoke Tests

Run local smoke checks:

```bash
pnpm smoke
```

Check these paths from a browser:

- `/`
- `/wiki/대문`
- `/servers`
- `/api/health`
- `/api/v1/auth/providers`

## Backup And Restore

Before deploys, back up MySQL and uploads:

```bash
mkdir -p backups
mysqldump --single-transaction --routines --triggers minewiki > backups/minewiki-$(date +%Y%m%d-%H%M%S).sql
tar -czf backups/uploads-$(date +%Y%m%d-%H%M%S).tar.gz apps/cdn/storage
```

Restore a database backup:

```bash
mysql minewiki < backups/minewiki-YYYYMMDD-HHMMSS.sql
```

Restore uploads:

```bash
tar -xzf backups/uploads-YYYYMMDD-HHMMSS.tar.gz -C /
```

## Rollback

Use the previous release commit or artifact:

```bash
git fetch origin
git checkout <previous-good-commit>
pnpm install --frozen-lockfile
pnpm exec prisma generate
pnpm build
pm2 startOrReload infra/pm2/ecosystem.config.cjs --update-env
sudo nginx -t
sudo systemctl reload nginx
pnpm smoke
```

If a migration changed data incompatibly, restore the database backup instead of trying to reverse SQL by hand.

`infra/rollback.example.sh` contains a minimal scripted rollback shape.

## Troubleshooting

### API 404 Behind Proxy

Confirm Nginx is using the supplied `/api/` rewrite. `/api/v1/auth/providers` must proxy to API path `/v1/auth/providers`, while `/api/health` must proxy to `/api/health`.

### Next Cannot Reach API

Set `INTERNAL_API_BASE_URL=http://127.0.0.1:3000` for server-side Next calls. Set `NEXT_PUBLIC_API_BASE_URL=https://minewiki.kr/api` for browser calls. Restart `minewiki-web` after changing `.env`.

### Redis Missing

`minewiki-api`, `minewiki-worker`, and `minewiki-bot` need Redis for queues and rate-limited workflows. Check `systemctl status redis-server`, `REDIS_URL`, and `pm2 logs minewiki-worker`.

### Discord Bot Token Missing

`minewiki-bot` requires `DISCORD_BOT_TOKEN`. The worker also uses the token for Discord digest and verification sync side effects. Missing token warnings are expected only in non-production.

### Plugin Sync `bad_signature`

Check that the plugin server secret matches the API-side canonical plugin server record, the timestamp is fresh, and the plugin sends the exact signed body. Also check proxy/body parsing changes that could alter JSON before signing.

### Wiki Page Not Found

Run `pnpm seed` after migrations, then verify `pnpm data:validate`. Confirm `namespaces`, `wiki_spaces`, `pages`, and `page_revisions` have the `/wiki/대문` seed rows.
