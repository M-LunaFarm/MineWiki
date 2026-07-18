FROM node:22-bookworm-slim AS builder

ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_MAIN_SITE_URL
ARG NEXT_PUBLIC_VERIFY_URL
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ARG NEXT_PUBLIC_HCAPTCHA_SITE_KEY
ARG NEXT_PUBLIC_PADDLE_CLIENT_TOKEN

ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_MAIN_SITE_URL=$NEXT_PUBLIC_MAIN_SITE_URL
ENV NEXT_PUBLIC_VERIFY_URL=$NEXT_PUBLIC_VERIFY_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_HCAPTCHA_SITE_KEY=$NEXT_PUBLIC_HCAPTCHA_SITE_KEY
ENV NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=$NEXT_PUBLIC_PADDLE_CLIENT_TOKEN

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY prisma/schema.prisma prisma/schema.prisma
COPY apps/web/package.json apps/web/package.json
COPY packages/clients/package.json packages/clients/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --filter @minewiki/web... --frozen-lockfile
COPY . .
RUN pnpm --filter @minewiki/web... --if-present build
RUN pnpm --filter @minewiki/web deploy --prod /opt/minewiki-web

FROM node:22-bookworm-slim AS production

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/minewiki-web ./

EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
