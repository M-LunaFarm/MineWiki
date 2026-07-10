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
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/security/package.json packages/security/package.json
RUN pnpm install --filter @minewiki/worker... --frozen-lockfile
COPY . .
RUN pnpm --filter @minewiki/worker exec prisma generate --schema /workspace/prisma/schema.prisma
RUN pnpm --filter @minewiki/worker... --if-present build
RUN pnpm --filter @minewiki/worker deploy /opt/minewiki-worker-build
RUN mkdir -p /opt/minewiki-worker-build/prisma \
    && cp prisma/schema.prisma /opt/minewiki-worker-build/prisma/schema.prisma \
    && cd /opt/minewiki-worker-build \
    && ./node_modules/.bin/prisma generate --schema prisma/schema.prisma
RUN pnpm --filter @minewiki/worker deploy --prod /opt/minewiki-worker
RUN node scripts/copy-prisma-client.mjs /opt/minewiki-worker-build /opt/minewiki-worker

FROM node:22-bookworm-slim AS production

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/minewiki-worker ./

CMD ["node", "dist/apps/worker/src/index.js"]
