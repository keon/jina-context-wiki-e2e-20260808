FROM node:24-slim AS deps

WORKDIR /app
COPY api/package.json api/package-lock.json* ./
RUN npm ci

FROM node:24-slim AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY api/package.json api/tsconfig.json ./
COPY api/src ./src
RUN npm run build

FROM node:24-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY api/package.json api/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

CMD ["node", "dist/index.js"]
