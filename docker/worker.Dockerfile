FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY . .
RUN npx prisma generate
ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "apps/api/src/worker.ts"]
