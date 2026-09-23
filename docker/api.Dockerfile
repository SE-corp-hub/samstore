FROM node:22-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY . .
RUN npx prisma generate

FROM base AS runtime
ENV NODE_ENV=production
ENV OUTBOX_WORKER_EMBEDDED=false
EXPOSE 4100
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
