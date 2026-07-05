# LunaF Verify (Web + Discord Bot)

This repository contains the web dashboard + API and the Discord bot for the LunaF Verify system.

## What's Included
- Web dashboard (Express + EJS): guild settings, servers, actions, routing, logs
- Web API (Express + MySQL): verification sessions, event delivery, bot webhook
- Discord bot (discord.js): `/verify` command and role/nickname updates
- Microsoft OAuth + Minecraft ownership verification
- MySQL schema for MariaDB/MySQL

## Setup
1) Install dependencies
```bash
npm install
```

2) Create database and apply schema
```bash
mysql -u root -p -e "CREATE DATABASE lunaf_verify CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p lunaf_verify < db/schema.sql
```

3) Configure environment
```bash
cp .env.example .env
```
Edit `.env` with your tokens, secrets, and DB credentials.

4) Run web and bot (separate terminals)
```bash
npm run start:web
npm run start:bot
```

Optional worker for retries:
```bash
npm run start:worker
```

## OAuth Setup
### Discord OAuth (Dashboard login)
- Redirect URI: `https://verify.lunaf.kr/auth/discord/callback`
- Scopes: `identify guilds`

### Microsoft OAuth (Minecraft ownership)
- Redirect URI: `https://verify.lunaf.kr/auth/microsoft/callback`
- Tenant: `common` (or your tenant)

## Notes
- The bot webhook expects `BOT_WEBHOOK_URL` to be `http://localhost:3100/bot/events` by default.
- Routing rules default to `all servers` when no rule exists.

## Useful Endpoints (Admin)
All admin endpoints require `X-Admin-Key`.

- `PUT /api/v1/guilds/:guildId/settings`
- `POST /api/v1/guilds/:guildId/servers`
- `GET /api/v1/guilds/:guildId/servers`
- `POST /api/v1/guilds/:guildId/action-profiles`
- `GET /api/v1/guilds/:guildId/action-profiles`

## Useful Endpoints (Internal)
All internal endpoints require `X-Internal-Key`.

- `POST /api/v1/verify/sessions`
- `POST /api/v1/verify/complete`
- `POST /api/v1/verify/revoke`
