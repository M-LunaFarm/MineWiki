# Repository Guidelines

## Project Structure & Module Organization
- `apps/` contains runtime applications: `api` (NestJS), `web` (Next.js), `worker` (BullMQ processors), `bot` (Discord gateway).
- `packages/` hosts shared libraries (`config`, `schemas`, `analytics`, `logger`, `security`, `clients`, `ui`), each published locally via file references.
- `docs/` keeps operational runbooks, checklists, and product copy. Prefer updating these before writing ad‑hoc notes.
- Tests live beside their targets (e.g., `apps/api/src/**/*.test.ts`, `apps/web/tests/`) to keep context close to implementation.

## Build, Test, and Development Commands
- `npm run dev:api` / `npm run dev:web` – start API or web app in watch mode. Run from repo root so shared env resolution works.
- `npm run build` – builds every app/package via workspace scripts; use before release tags.
- `npm --prefix apps/api run test` – executes NestJS unit suites (tsx test runner).
- `npm --prefix apps/web run test:e2e` – runs Playwright flows against a dev server.

## Coding Style & Naming Conventions
- TypeScript everywhere; stick to 2‑space indentation and trailing commas (configured via Prettier).
- ESLint configs are centralized (`eslint.config.js`). Run `npm run lint` before opening a PR.
- File naming: kebab-case for React components (`account-dropdown.tsx`), dot-suffix for tests (`*.test.ts`).

## Testing Guidelines
- API: keep unit tests in the same directory as implementation; describe blocks mirror public methods.
- Web: Playwright specs live in `apps/web/tests/`; prefer scenario names that read like user stories.
- Always add regression coverage when fixing regressions—target the smallest layer (unit before e2e).

## Commit & Pull Request Guidelines
- Commit messages follow “scope: summary” (e.g., `auth: add naver oauth flow`). Squash related WIP commits locally.
- Pull requests include: summary of changes, testing evidence (`npm --prefix … run test` logs), and linked issue/OKR. Attach screenshots or GIFs for UI impact.
- Rebase onto `master` before requesting review; resolve conflicts locally to keep CI clean.

## Security & Configuration Tips
- Environment variables load through `packages/config`; never hardcode secrets. Update `.env.example` when introducing new keys.
- API telemetry relies on `OBSERVABILITY_ENDPOINT`; ensure sandbox endpoints are safe before enabling.
