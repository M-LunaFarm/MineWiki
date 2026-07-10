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
COPY apps/bot/package.json apps/bot/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/schemas/package.json packages/schemas/package.json
RUN pnpm install --filter @minewiki/bot... --frozen-lockfile
COPY . .
RUN pnpm --filter @minewiki/bot exec prisma generate --schema /workspace/prisma/schema.prisma
RUN pnpm --filter @minewiki/bot... --if-present build
RUN pnpm --filter @minewiki/bot deploy /opt/minewiki-bot-build
RUN mkdir -p /opt/minewiki-bot-build/prisma \
    && cp prisma/schema.prisma /opt/minewiki-bot-build/prisma/schema.prisma \
    && cd /opt/minewiki-bot-build \
    && ./node_modules/.bin/prisma generate --schema prisma/schema.prisma
RUN pnpm --filter @minewiki/bot deploy --prod /opt/minewiki-bot
RUN node scripts/copy-prisma-client.mjs /opt/minewiki-bot-build /opt/minewiki-bot

FROM node:22-bookworm-slim AS production

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/minewiki-bot ./

CMD ["node", "dist/apps/bot/src/index.js"]
