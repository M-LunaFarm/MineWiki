# MineWiki Integrated Monorepo

MineWiki keeps the wiki as the main product, promotes the former VoteWeb code into the server directory and voting engine, and freezes the former LunaVotifier service as a legacy migration source.

## Official Service and OAuth Callbacks

- Service: [MineWiki](https://minewiki.kr)
- Verification service: [verify.minewiki.kr](https://verify.minewiki.kr)
- Support: [support@minewiki.kr](mailto:support@minewiki.kr)

Register the following URLs exactly in each provider console. Production callbacks must use HTTPS and must not be replaced with the local development address.

| Provider | Provider console callback / redirect URI | Environment variable |
| --- | --- | --- |
| NAVER Login | `https://minewiki.kr/auth/callback/naver` | `NAVER_REDIRECT_URI` |
| Discord OAuth2 | `https://minewiki.kr/auth/callback/discord` | `DISCORD_REDIRECT_URI` |
| Microsoft identity platform / Minecraft ownership | `https://verify.minewiki.kr/minecraft/callback` | `MICROSOFT_REDIRECT_URI` |

Copy-and-paste values:

```dotenv
NAVER_REDIRECT_URI=https://minewiki.kr/auth/callback/naver
DISCORD_REDIRECT_URI=https://minewiki.kr/auth/callback/discord
MICROSOFT_REDIRECT_URI=https://verify.minewiki.kr/minecraft/callback
```

These are public redirect addresses, not OAuth client secrets. Keep each provider's client ID and client secret only in the production secret store.

Useful provider registration URLs:

- Homepage URL: `https://minewiki.kr`
- Terms of service: `https://minewiki.kr/policies/terms`
- Privacy policy: `https://minewiki.kr/policies/privacy`
- Microsoft publisher verification file: `https://minewiki.kr/.well-known/microsoft-identity-association.json`

The Microsoft callback intentionally belongs to the isolated verification service. `verify.minewiki.kr` completes the ownership proof without receiving the main `minewiki.kr` session cookie.

## Brand Assets

The following production URLs return the original downloadable PNG files and may be supplied to OAuth provider consoles. Open a link and save the image without resizing it.

| Asset | Size | Download |
| --- | ---: | --- |
| MineWiki app icon | 512 × 512 | [Download PNG](https://minewiki.kr/icon) |
| Apple touch icon | 180 × 180 | [Download PNG](https://minewiki.kr/apple-icon) |
| Open Graph image | 1200 × 630 | [Download PNG](https://minewiki.kr/og) |

![MineWiki app icon](https://minewiki.kr/icon)

## Product Routing

- `/`, `/wiki/*`, `/mod/*`, `/server/*`, `/dev/*`: `apps/web`
- `/servers`, `/servers/:id`, `/support`, `/me`, `/guilds/*`: `apps/web`
- `/api/*`: `apps/api`
- `/uploads/*`: permission-aware file reads through `apps/api`
- Discord verification and Minecraft account linking: `apps/api`, `apps/bot`, and `apps/worker`

## App Boundaries

- `apps/web`: unified Next.js UI for wiki, server ranking, accounts, support, and guild management
- `apps/api`: Nest API for accounts, server directory, voting, ownership, Minecraft auth, and support
- `apps/worker`: BullMQ workers for pinging, vote dispatch, claims, ranks, and digest jobs
- `apps/bot`: Discord command surface, now under the `/minewiki` command family
- `legacy/*` and `apps/cdn`: migration-only references; neither is an active workspace or production service

## Data Integration

- `Account.id` remains the canonical cross-product account id.
- `apps/wiki` keeps its local `users.id` for wiki permissions and maps to `users.account_id`.
- `Server.id` maps to wiki spaces through `Server.wikiSpaceId`, `Server.wikiPageId`, and `Server.wikiSlug`.
- `server_wikis.vote_server_id` links wiki server pages back to the server directory.

## Production Runtime Lock

Production starts only the integrated runtime defined in `infra/pm2/ecosystem.config.cjs`:

- `minewiki-web`
- `minewiki-api`
- `minewiki-worker`
- `minewiki-bot`

Use `pnpm deploy:build` before reload and `pnpm deploy:smoke` after reload. Do not run `legacy/mwiki-fastify`, `legacy/luna-votifier`, or any old VoteWeb runtime in production; those directories are migration references only.

`pnpm db:deploy` safely bootstraps a completely empty database from the current Prisma schema, or applies additive migrations when application tables already exist. It never replaces a non-empty database with `db push`.

## Container Builds

Build the production images from the repository root so pnpm workspace packages are available:

```bash
docker build -f apps/api/Dockerfile -t minewiki-api .
docker build -f apps/worker/Dockerfile -t minewiki-worker .
docker build -f apps/bot/Dockerfile -t minewiki-bot .
docker build -f apps/web/Dockerfile -t minewiki-web .
```

Set `INTERNAL_API_BASE_URL` on the web container to the API container's internal URL, for example `http://minewiki-api:3000`. Browser requests continue to use `NEXT_PUBLIC_API_BASE_URL` (normally `/api` behind the web container or reverse proxy).

For a complete local container stack, copy `.env.example` to `.env`, replace every `change-me` value, and configure SMTP plus one complete CAPTCHA provider (site key and secret). Then run:

```bash
docker compose up -d --build
curl http://localhost:8080/api/health
```

The default stack includes MySQL, Redis, migrations, idempotent baseline seeding, API, worker, web, and the Nginx gateway. Start the Discord bot after setting its token and client ID with `docker compose --profile bot up -d --build`. Change `MINEWIKI_PUBLIC_URL` and terminate TLS in an external reverse proxy for a public deployment.

After creating the first account, grant it the owner role through the same migration image:

```bash
docker compose run --rm -e SEED_ADMIN_EMAIL=you@example.com migrate node scripts/seed.mjs
```

The seed is idempotent, so this command preserves existing pages and role assignments.

## Data Validation

Run `pnpm data:validate` before deploys to check migration integrity across wiki pages, server wiki links, account/profile mappings, uploads, canonical plugin credentials, replay guards, and render cache readiness. The command is read-only by default. Use `pnpm data:validate -- --fix` only when you want safe repairs for orphan plugin credentials, expired plugin replay guards, and missing current render cache entries.

## First-Run Seed

Run `pnpm seed -- --dry-run` to preview first-run seed changes, then `pnpm seed` after migrations. The seed is idempotent and never overwrites existing `/wiki/대문`, `/help/대문`, or `/project/대문` pages. To create the first admin, create an account through the app, then run `pnpm seed -- --admin-email=you@example.com`, set `SEED_ADMIN_EMAIL`, or use the Compose command above. Verify the result with `pnpm smoke` or by opening `/wiki/대문`.
