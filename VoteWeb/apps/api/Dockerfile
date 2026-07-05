FROM node:20-alpine AS base
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

FROM base AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM base AS production
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
CMD ["node", "dist/main.js"]
