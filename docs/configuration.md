# MineWiki Configuration

Copy `.env.example` to `.env`, replace placeholders, then restart all PM2 processes with `pm2 startOrReload infra/pm2/ecosystem.config.cjs --update-env`.

Production startup fails when required secrets are empty or still use placeholder values such as `change-me`.

## Core Runtime

- `NODE_ENV`: `production` for deployed processes.
- `DATABASE_URL`: MySQL connection string, for example `mysql://minewiki:strong-password@127.0.0.1:3306/minewiki`.
- `REDIS_URL`: Redis connection string used by queues and rate limits.
- `NEXT_PUBLIC_SITE_URL`: Public canonical site URL.
- `NEXT_PUBLIC_API_BASE_URL`: Browser-visible API base URL, usually `https://minewiki.kr/api`.
- `INTERNAL_API_BASE_URL`: Server-side API base URL for internal calls, usually `http://127.0.0.1:3000`.
- `API_HOST`: API bind host. Production PM2 uses `127.0.0.1`.
- `API_PORT`: API port. Production PM2 uses `3000`.
- `VERIFY_PUBLIC_BASE_URL`: Public URL used in verification links.
- `APP_ENCRYPTION_KEY`: Required in production for encrypted stored integration secrets.

## Discord And Plugin Sync

- `DISCORD_BOT_TOKEN`: Token for `minewiki-bot` and worker-side Discord delivery.
- `DISCORD_CLIENT_ID`: Discord OAuth application client id.
- `DISCORD_CLIENT_SECRET`: Discord OAuth client secret.
- `DISCORD_REDIRECT_URI`: Discord OAuth callback, for example `https://minewiki.kr/auth/callback/discord`.
- `INTERNAL_BOT_API_TOKEN`: Shared token for internal bot-to-API calls.
- `PLUGIN_SYNC_TOKEN`: Shared plugin sync secret for legacy/internal plugin integrations.

## Minecraft And OAuth

- `MICROSOFT_CLIENT_ID`: Microsoft OAuth client id for Minecraft account linking.
- `MICROSOFT_CLIENT_SECRET`: Microsoft OAuth client secret.
- `MICROSOFT_REDIRECT_URI`: Microsoft callback URL, for example `https://minewiki.kr/minecraft/callback`.
- `NAVER_CLIENT_ID`: Naver OAuth client id.
- `NAVER_CLIENT_SECRET`: Naver OAuth client secret.
- `NAVER_REDIRECT_URI`: Naver OAuth callback, for example `https://minewiki.kr/auth/callback/naver`.

## Anti-Abuse

- `NEXT_PUBLIC_TURNSTILE_SITE_KEY`: Browser-visible Turnstile site key.
- `TURNSTILE_SECRET_KEY`: Server-side Turnstile secret.
- `NEXT_PUBLIC_HCAPTCHA_SITE_KEY`: Browser-visible hCaptcha site key.
- `HCAPTCHA_SECRET_KEY`: Server-side hCaptcha secret.

Production requires at least one server-side CAPTCHA secret: `TURNSTILE_SECRET_KEY` or `HCAPTCHA_SECRET_KEY`.

## Uploads And Storage

- `UPLOAD_STORAGE_ROOT`: Local upload root used when object storage is not configured.
- `STORAGE_PUBLIC_BASE_URL`: Public base URL for uploaded files.
- `STORAGE_ENDPOINT`: S3-compatible endpoint when object storage is used.
- `STORAGE_REGION`: S3-compatible region. Required when `STORAGE_BUCKET` is set.
- `STORAGE_BUCKET`: Object storage bucket name.
- `STORAGE_ACCESS_KEY`: Object storage access key. Required when `STORAGE_BUCKET` is set.
- `STORAGE_SECRET_KEY`: Object storage secret key. Required when `STORAGE_BUCKET` is set.

## Mail

- `SMTP_HOST`: SMTP server host. Required in production.
- `SMTP_PORT`: SMTP port, usually `587` or `465`.
- `SMTP_USER`: SMTP username when the provider requires auth.
- `SMTP_PASS`: SMTP password when the provider requires auth.
- `SMTP_SECURE`: `true` for implicit TLS, usually port `465`.
- `SMTP_FROM`: Sender address, for example `MineWiki <no-reply@minewiki.kr>`.

## Observability

- `SENTRY_DSN`: Optional Sentry DSN.
- `OBSERVABILITY_ENDPOINT`: Optional telemetry endpoint.
- `OBSERVABILITY_API_KEY`: Optional telemetry API key.

## Validation

Validate config before deploy:

```bash
NODE_ENV=production pnpm --dir packages/config test
pnpm check
```

Then start processes with the same `.env` file PM2 will use:

```bash
pm2 startOrReload infra/pm2/ecosystem.config.cjs --update-env
```

## Test Environment

Use `.env.test.example` as the template for local integration testing. Most unit tests skip database-backed cases when `DATABASE_URL` is unset. CI provides MySQL and Redis services, runs `prisma migrate deploy`, then runs both `pnpm test:unit` and `pnpm test:integration`.
