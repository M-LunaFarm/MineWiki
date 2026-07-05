# MineWiki Integrated Monorepo

MineWiki keeps the wiki as the main product, promotes the former VoteWeb code into the server directory and voting engine, and freezes the former LunaVotifier service as a legacy migration source.

## Product Routing

- `/`, `/wiki/*`, `/mod/*`, `/server/*`, `/dev/*`: `apps/wiki`
- `/servers`, `/servers/:id`: `apps/web`
- `/api/*`: `apps/api`
- `/cdn/*`: `apps/cdn`
- `/verify` and Minecraft account linking: migrate into `apps/api`, `apps/bot`, and `apps/worker`

## App Boundaries

- `apps/wiki`: Fastify MineWiki engine and server wiki documents
- `apps/web`: MineWiki Servers Next.js UI
- `apps/api`: Nest API for accounts, server directory, voting, ownership, Minecraft auth, and support
- `apps/worker`: BullMQ workers for pinging, vote dispatch, claims, ranks, and digest jobs
- `apps/bot`: Discord command surface, now under the `/minewiki` command family
- `legacy/luna-votifier`: migration-only source for Discord/Minecraft verification behavior

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
