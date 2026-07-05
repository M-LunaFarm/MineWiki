#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Installing root dependencies..."
npm install

echo "Installing app/package dependencies..."
npm run bootstrap

echo "Generating Prisma client..."
node_modules/.bin/prisma generate --schema prisma/schema.prisma

echo "Syncing Prisma client into app node_modules..."
for pkg in apps/api apps/worker apps/bot; do
  mkdir -p "$pkg/node_modules/.prisma"
  cp -R node_modules/.prisma/. "$pkg/node_modules/.prisma/"
done

echo "Building all apps..."
npm run build

echo "Starting/reloading PM2 processes..."
pm2 reload ecosystem.config.cjs --env production || pm2 start ecosystem.config.cjs --env production
pm2 save
