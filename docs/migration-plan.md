# MineWiki Migration Plan

Migration order:

1. Promote the VoteWeb monorepo shape to the repository root.
2. Rename package scopes and user-facing branding to MineWiki.
3. Move legacy source trees under `legacy/` and extract reusable wiki code to `packages/wiki-core`.
4. Map existing wiki tables in Prisma with additive migrations only.
5. Connect canonical `Account` records to legacy wiki profiles.
6. Move wiki read and edit APIs into `apps/api`.
7. Move wiki read and edit UI into `apps/web`.
8. Connect server directory records to server wiki spaces.
9. Port LunaVotifier verification, Discord bot behavior, and plugin sync into the unified apps.
10. Remove legacy runtimes from production startup and deploy only web, api, worker, and bot.

Rollback:

- Keep legacy source available until migration data is verified.
- Roll back by checking out a known release ref, reinstalling dependencies, running additive migrations, rebuilding, and reloading PM2/nginx.
- Do not delete legacy tables or identity columns until data parity is proven.
