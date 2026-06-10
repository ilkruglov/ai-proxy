# Build Stage
FROM node:24-slim AS builder
WORKDIR /app
RUN npm i -g bun@1.3.6

# Install dependencies from the lockfile
COPY package.json bun.lock ./
RUN bun i --frozen-lockfile

# Copy the rest of the application source code and build
COPY . .
RUN bun run build

# Production-only dependencies, assembled here so the runtime image needs no bun
RUN bun i --prod --frozen-lockfile

# Production Stage
FROM node:24-slim AS production
WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3000

# drop root: the node base image ships an unprivileged "node" user
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/" || exit 1

# node directly as PID 1 so the container reacts to SIGTERM promptly
CMD ["node", "./dist/server.js"]
