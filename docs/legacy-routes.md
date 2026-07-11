# Legacy Route Redirects

MineWiki no longer runs the legacy `mwiki-fastify` or `luna-votifier` web services in production. Public bookmarks are preserved where the current monorepo has an equivalent route.

## Permanent Content Redirects

These routes use `301` because they identify content or public informational pages:

- `/wiki` -> `/wiki/대문`
- `/wiki/서버/*` -> `/server/*`
- `/wiki/모드/*` -> `/mod/*`
- `/wiki/모드팩/*` -> `/modpack/*`
- `/wiki/개발/*` and `/develop/*` -> `/dev/*`
- `/wiki/도움말/*` -> `/help/*`
- `/wiki/프로젝트/*` -> `/project/*`
- `/wiki/파일/*` and `/files/*` -> `/file/*`
- `/file/*/raw` -> `/file/*`
- `/server` -> `/servers`
- `/mods` -> `/mod`
- `/modpack` -> `/modpack/대문`
- `/privacy` -> `/policies/privacy`
- `/terms` -> `/policies/terms`
- `/info` -> `/support`

## Temporary Flow Redirects

These routes use `302` because they are account, ownership, or management flows:

- `/verify/:sessionId` -> `/me?verifySessionId=:sessionId`
- `/verify` -> `/me?verifyMigration=legacy`
- `/verify-email` -> `/auth`
- `/join` -> `/auth?mode=register`
- `/forgot-password` -> `/login/forgot-password`
- `/reset-password` -> `/login/reset-password`
- `/auth/discord` -> `/auth`
- `/auth/discord/callback` -> `/auth/callback/discord`
- `/auth/microsoft` and `/auth/microsoft/result` -> `/me`
- `/auth/microsoft/callback` -> `/minecraft/callback`
- `/logout` -> `/me`
- `/servers/new` -> `/servers/register`
- `/servers/import` -> `/servers/register?import=1`
- `/mods/new` -> `/mod`
- `/server/:slug/manage` -> `/dashboard?server=:slug`
- `/server/:slug/claim` -> `/claim?server=:slug`
- `/mod/:slug/manage` -> `/mod/:slug`
- `/guilds/select` -> `/guilds`
- `/guilds/:guildId/messages`, `/servers`, `/actions`, `/routing`, `/members`, and `/logs` -> `/guilds/:guildId`

## API Compatibility

The canonical plugin sync endpoint is `/v1/plugin/sync`. Legacy plugin clients can still post to:

- `/api/v1/plugin/sync`
- `/api/v1/plugin/sync-9b4f7d2c6a5e4f3aa1d8b9a7c6e5d4f3`

Legacy Luna verify web pages are not served. A legacy `/verify/:sessionId` bookmark now opens the current Minecraft ownership flow and shows the migrated state there.

## Removed Without Redirect

Legacy admin-only HTML dashboards, old wiki editing form posts, and internal audit/export/job endpoints are intentionally not redirected. Their replacements are the current API controllers, `/dashboard`, `/guilds`, `/admin/wiki`, `/admin/audit`, and deployment scripts.
