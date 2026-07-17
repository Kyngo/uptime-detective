# Stage 1: Build
FROM node:24-alpine AS builder

# Install build tools for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm install

# Copy source
COPY shared/ ./shared/
COPY server/ ./server/
COPY client/ ./client/

# Build all packages
RUN npm run build

# Prune to production dependencies (reuses compiled native modules)
RUN npm prune --omit=dev

# Stage 2: Production
FROM node:24-alpine AS production

RUN apk add --no-cache iputils

WORKDIR /app

# Copy built assets and production node_modules from builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/shared/dist/ ./shared/dist/
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/server/dist/ ./server/dist/
COPY --from=builder /app/client/dist/ ./client/dist/

# Create data directory and set ownership to node user
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
ENV PORT=3300
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/uptime-detective.db

# Run as non-root user
USER node

EXPOSE 3300

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3300/api/v1/health || exit 1

CMD ["node", "server/dist/index.js"]
