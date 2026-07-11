# Legacy Decommission Checklist

Last reviewed: 2026-07-06

This checklist defines the final path for deleting legacy service references after production parity is verified.

## Current Legacy Inventory

- `legacy/mwiki-fastify`: retained as migration reference only.
- `legacy/luna-votifier`: retained as migration reference only.
- `packages/wiki-core`: active shared package, not legacy.
- Active workspace globs are only `apps/*` and `packages/*`; `legacy/*` is not part of the workspace.
- Active PM2 ecosystem declares only:
  - `minewiki-web`
  - `minewiki-api`
  - `minewiki-worker`
  - `minewiki-bot`

PM2 check on 2026-07-06 returned an empty process list from `pm2 jlist` in this shell. The command printed a HOME/HOMEPATH warning and defaulted to `/etc/.pm2`, so production should repeat the check with the deployment user's PM2 home.

## Feature Parity Checklist

| Legacy capability | Current owner | Status |
| --- | --- | --- |
| Wiki read moved | `apps/api/src/wiki/wiki-read.service.ts`, `apps/web/app/wiki`, namespace routes | Complete |
| Wiki edit moved | `apps/api/src/wiki/wiki-edit.service.ts`, `apps/web/components/wiki/wiki-editor-client.tsx` | Complete |
| Wiki history/diff moved | `apps/web/app/wiki/revision`, `apps/web/app/wiki/diff`, history route pages | Complete |
| Wiki recent moved | `apps/web/app/recent/page.tsx`, wiki recent API | Complete |
| Wiki search moved | `apps/web/app/search/page.tsx`, wiki search API | Complete |
| Wiki file upload moved | `apps/api/src/file`, `apps/api/src/upload`, wiki editor file picker | Complete |
| Wiki admin moved | `apps/api/src/wiki/wiki-admin.*`, `apps/web/app/admin/wiki` | Complete |
| Server wiki linked | `Server.wikiSpaceId`, `Server.wikiPageId`, `/server/*`, server owner controls | Complete |
| Discord verify moved | `apps/api/src/verify`, `/me?verifySessionId=...`, Minecraft ownership panel | Complete |
| Plugin sync moved | `/v1/plugin/sync`, canonical `PluginServer`, HMAC/replay/cooldown | Complete |
| Guild dashboard moved | `apps/web/app/guilds`, `apps/api/src/verify/guild.*` | Complete |
| Deployment uses only current apps | `infra/pm2/ecosystem.config.cjs` | Complete |
| Smoke tests pass | `pnpm smoke` against deployed web/API | Required before deletion |
| Data validation passes | `pnpm data:validate` against production DB | Required before deletion |

## Legacy Route Disposition

Canonical route redirects are documented in `docs/legacy-routes.md`.

| Old route family | Disposition |
| --- | --- |
| `/wiki`, `/wiki/서버/*`, `/wiki/모드/*`, `/wiki/모드팩/*`, `/wiki/개발/*`, `/develop/*`, `/wiki/도움말/*`, `/wiki/프로젝트/*`, `/wiki/파일/*`, `/files/*` | Replaced by canonical wiki namespace routes and redirected. |
| `/file/*/raw` | Replaced by permission-aware file wiki route and redirected to `/file/*`. |
| `/server`, `/servers/new`, `/servers/import`, `/server/:slug/manage`, `/server/:slug/claim` | Replaced by `/servers`, `/servers/register`, `/dashboard`, and `/claim`; redirected. |
| `/mods`, `/mods/new`, `/mod/:slug/manage`, `/modpack` | Replaced by canonical wiki namespace routes; redirected. |
| `/verify`, `/verify/:sessionId`, `/auth/microsoft*` | Replaced by account/Minecraft ownership flow; redirected. |
| `/verify-email`, `/join`, `/forgot-password`, `/reset-password`, `/auth/discord*`, `/logout` | Replaced by current auth routes; redirected. |
| `/guilds/select`, `/guilds/:guildId/messages`, `/servers`, `/actions`, `/routing`, `/members`, `/logs` | Replaced by current guild list/detail/settings pages; redirected. |
| `/api/v1/plugin/sync`, `/api/v1/plugin/sync-9b4f7d2c6a5e4f3aa1d8b9a7c6e5d4f3` | Kept as compatibility aliases for `/v1/plugin/sync`. Remove after plugin clients have upgraded. |
| Legacy admin HTML dashboards, old wiki edit form posts, internal export/job/audit endpoints | Removed without redirect; replacements are current API controllers, `/dashboard`, `/guilds`, `/admin/wiki`, `/admin/audit`, and deployment scripts. |

## Final Verification Gate

Run these commands on the production release candidate before deleting `legacy/`:

```bash
pnpm install --frozen-lockfile
pnpm prisma generate
pnpm prisma migrate deploy
pnpm build
pnpm test:unit
pnpm check
SMOKE_WEB_BASE_URL=https://minewiki.kr SMOKE_API_BASE_URL=https://minewiki.kr/api pnpm smoke
pnpm data:validate
pm2 jlist
```

The PM2 output must contain only the current MineWiki processes listed above. If any legacy process name, cwd, or script path references `legacy/mwiki-fastify` or `legacy/luna-votifier`, stop and update the deployment first.

## Deletion Criteria

The legacy directories can be deleted when all of the following are true:

- Production has run only `apps/web`, `apps/api`, `apps/worker`, and `apps/bot` for one full release window.
- `pnpm smoke` passes against the production web/API URLs.
- `pnpm data:validate` passes against the production database with no errors.
- Redirect monitoring shows no unresolved critical legacy route traffic, except accepted plugin sync compatibility aliases.
- Plugin clients have migrated from legacy plugin sync aliases to `/v1/plugin/sync`.
- The latest backup containing legacy source and migration reference data has been retained outside the deployment workspace.

After those gates pass, delete `legacy/mwiki-fastify` and `legacy/luna-votifier`, remove the plugin sync compatibility aliases only after client migration, and update `docs/legacy-routes.md` to mark compatibility aliases as removed.
