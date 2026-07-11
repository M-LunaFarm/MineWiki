# MineWiki Security Review

Last reviewed: 2026-07-06

## Launch Blocker Status

| Area | Status | Evidence |
| --- | --- | --- |
| Auth cookies | Pass | `SessionService` issues `mw_session` as `httpOnly`, `secure`, `sameSite=strict`, scoped to `/`. |
| CSRF | Pass | Unsafe cookie-auth requests require `x-csrf-token`; bearer and same-origin safe cases are covered by `session/csrf.test.ts`. |
| OAuth state | Pass | OAuth and Microsoft flows bind state to redirect URI/account context and reject mismatches. |
| Discord verify token | Pass | Create response keeps `verifyToken` for bot flow; public get/complete responses sanitize it. |
| Plugin sync HMAC/replay | Pass | Plugin sync verifies HMAC, timestamp skew, nonce replay, and per-server cooldown. |
| File upload/raw serving | Pass | Uploads run image magic/size validation and file reads go through permission checks. |
| Wiki markup rendering | Pass | Blocking markup errors reject saves; renderer strips dangerous HTML paths. |
| Wiki permission/ACL | Pass | Read/edit/create/admin paths enforce profile, protection, ACL, owner, group, and elevated checks. |
| Server ping SSRF | Pass | Ping, MOTD, diagnostics, and worker probes use `validateOutboundTarget`. |
| Votifier dispatch | Pass | Server owners/admins manage encrypted Votifier secrets; dispatch records retryable/non-retryable failures. |
| Admin endpoints | Pass | Admin audit/wiki/support endpoints require elevated or explicit admin/support permissions. |
| Secrets in logs/events | Patched | Audit metadata and plugin sync event payloads redact token/secret/password/credential/cookie fields and sensitive URL query values. |
| Public API token exposure | Pass | Public Discord verification lookup/complete responses omit one-time completion tokens. |
| Rate limits | Pass | Login, vote, verify, upload, plugin sync, and high-risk mutation routes are throttled or cooldown-protected. |
| Production secret validation | Pass | `ConfigService` fails closed in production when critical secrets, CAPTCHA, URLs, Redis, SMTP, or encryption keys are missing or placeholder values. |

## Critical Behaviors Covered By Tests

- `apps/api/src/verify/verify.service.unit.test.ts`: Discord verify token visibility, missing/wrong token rejection, correct token completion.
- `apps/api/src/plugin-sync/plugin-sync.service.test.ts`: HMAC rejection, stale timestamp rejection, nonce replay rejection, cooldown, canonical plugin server path, sensitive audit payload redaction.
- `apps/api/src/events/business-event.service.test.ts`: recursive audit metadata redaction.
- `apps/api/src/session/csrf.test.ts`: CSRF enforcement.
- `packages/security/test/validateOutboundTarget.test.ts`: SSRF/private address blocking.
- `packages/config/tests/config.test.mjs`: production fail-closed configuration.

## Operational Requirements

- Production must set `NODE_ENV=production`; otherwise production-only config validation is intentionally not enforced.
- Set only `MINEWIKI_ENV_FILE` for custom environment loading. Legacy env file names are not part of the active service contract.
- Rotate any plugin or Votifier secrets that may have been present in logs or event payloads before this redaction pass.
- Keep `APP_ENCRYPTION_KEY` stable across deploys. Losing it prevents decrypting encrypted Votifier and app secrets.
- Keep CAPTCHA configured with either Turnstile or hCaptcha before public launch.
