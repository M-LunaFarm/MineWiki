FROM node:22-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY prisma/schema.prisma prisma/schema.prisma
COPY apps/api/package.json apps/api/package.json
COPY packages/analytics/package.json packages/analytics/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/minecraft/package.json packages/minecraft/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/security/package.json packages/security/package.json
COPY packages/wiki-core/package.json packages/wiki-core/package.json
RUN pnpm install --filter @minewiki/api... --frozen-lockfile
COPY . .
RUN pnpm --filter @minewiki/api exec prisma generate --schema /workspace/prisma/schema.prisma
RUN pnpm --filter @minewiki/api... --if-present build
RUN pnpm --filter @minewiki/api deploy /opt/minewiki-api-build
RUN mkdir -p /opt/minewiki-api-build/prisma \
    && cp prisma/schema.prisma /opt/minewiki-api-build/prisma/schema.prisma \
    && cd /opt/minewiki-api-build \
    && ./node_modules/.bin/prisma generate --schema prisma/schema.prisma
RUN pnpm --filter @minewiki/api deploy --prod /opt/minewiki-api
RUN node scripts/copy-prisma-client.mjs /opt/minewiki-api-build /opt/minewiki-api

FROM node:22-bookworm-slim AS production

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/minewiki-api ./

EXPOSE 3000
CMD ["node", "dist/apps/api/src/main.js"]
