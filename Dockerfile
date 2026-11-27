# syntax=docker/dockerfile:1
# StockDesk runtime image.
#
# Base image: Node.js 24 (Active LTS, supported until April 2028), Debian slim variant.
# TODO verify: pin the digest. Docker Hub could not be reached from the environment
# where these files were prepared, so no digest is written here. Get it with:
#   docker buildx imagetools inspect node:24-bookworm-slim
# then use:  FROM node:24-bookworm-slim@sha256:<digest>
# Dependabot (see .github/dependabot.yml) keeps the digest up to date afterwards.
FROM node:25-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Copy only what the application needs (see also .dockerignore): no .env, no .git,
# no k8s/ manifests, no tests. Files stay owned by root and are read-only for the
# runtime user, so a compromised process cannot rewrite the code.
COPY package.json package-lock.json ./
# No runtime dependency today; npm ci keeps the build reproducible when one is added.
# --ignore-scripts: no install script of a dependency runs during the build.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src/ ./src/

# Unprivileged numeric user (no entry needed in /etc/passwd). Above 10000 so it
# cannot collide with a user of the node. Same uid in k8s/deployment.yaml.
USER 10001:10001

# Only the application port. The Node inspector (9229) is no longer exposed:
# it gave remote code execution to anyone who could reach it.
EXPOSE 3000

# Docker-level health check (used by docker compose; Kubernetes uses its own probes).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/livez').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# No --inspect. To debug locally, use docker-compose.debug.yml (bound to 127.0.0.1).
CMD ["node", "src/server.js"]
