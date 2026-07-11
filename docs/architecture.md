# MineWiki Integration Architecture

MineWiki is consolidated around one product runtime:

- `apps/web`: the single Next.js frontend for every user-facing route.
- `apps/api`: the single NestJS backend for HTTP APIs.
- `apps/worker`: queue processors and asynchronous jobs.
- `apps/bot`: the Discord bot.
- `legacy/mwiki-fastify` and `legacy/luna-votifier`: temporary migration sources only.

Canonical domain concepts:

- `Account` is the canonical login identity.
- `WikiProfile` maps existing mwiki users to `Account`.
- `Server` is the canonical server directory entity.
- `ServerWiki` and `WikiSpace` connect wiki content to `Server`.

Migration safety checklist:

- Do not ship destructive database migrations without a backfill.
- Keep old URLs redirected.
- Preserve page revision history.
- Preserve user attribution.
- Preserve server votes and reviews.
- Preserve Minecraft identity and guild verification data.
