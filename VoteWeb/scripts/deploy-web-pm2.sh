#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WEB_PREFIX="apps/web"
WEB_PROCESS="voteweb-web"
WEB_BASE="http://127.0.0.1:4311"
export HOME="${HOME:-/root}"

echo "[deploy-web] Building web app..."
npm --prefix "$WEB_PREFIX" run build

echo "[deploy-web] Restarting PM2 process: $WEB_PROCESS"
pm2 restart "$WEB_PROCESS" --update-env

# Give Next.js a moment to initialize before smoke tests.
sleep 2

echo "[deploy-web] Running chunk smoke test for /me..."
ME_HTML="$(curl -fsS "$WEB_BASE/me")"
ME_CHUNK_PATH="$(printf '%s' "$ME_HTML" | grep -oE '/_next/static/chunks/app/me/page-[a-f0-9]+\.js' | head -n1 || true)"

if [[ -z "$ME_CHUNK_PATH" ]]; then
  echo "[deploy-web] ERROR: Could not detect /me page chunk in HTML response."
  exit 1
fi

ME_CHUNK_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$WEB_BASE$ME_CHUNK_PATH")"
if [[ "$ME_CHUNK_STATUS" != "200" ]]; then
  echo "[deploy-web] ERROR: /me chunk check failed ($ME_CHUNK_STATUS) for $ME_CHUNK_PATH"
  exit 1
fi

echo "[deploy-web] OK: /me chunk is healthy: $ME_CHUNK_PATH"
