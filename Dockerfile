# ---- build stage: compile native modules (node-pty)
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime stage
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl bash nano less tini \
    && rm -rf /var/lib/apt/lists/*

# cloudflared for per-user Cloudflare Tunnels (TARGETARCH = amd64 / arm64, set by buildx)
ARG TARGETARCH
ARG CLOUDFLARED_VERSION=2025.11.1
RUN curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH:-amd64}" \
    && chmod +x /usr/local/bin/cloudflared \
    && cloudflared --version

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    DATA_DIR=/data \
    ADMIN_PORT=8080 \
    HOSTING_PORT=8081 \
    HOSTING_PUBLIC_PORT=80 \
    SITE_PORT_RANGE=8100-8199

VOLUME ["/data"]
EXPOSE 8080 8081 8100-8199

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${ADMIN_PORT}/api/public || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
