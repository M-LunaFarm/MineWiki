#!/usr/bin/env bash
set -euo pipefail

release_ref="${1:?usage: infra/rollback.example.sh <git-ref-or-tag>}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$repo_root"
git fetch --all --tags --prune
git checkout "$release_ref"
pnpm install --frozen-lockfile
pnpm exec prisma migrate deploy
pnpm build
pm2 startOrReload infra/pm2/ecosystem.config.cjs --update-env
nginx -t
systemctl reload nginx
pnpm smoke
