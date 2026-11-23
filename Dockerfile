# syntax=docker/dockerfile:1

# --- Build the TypeScript daemon -------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
RUN npm install --global pnpm@12
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build
# Leave only what the daemon needs at run time for the next stage to copy.
RUN pnpm prune --prod

# --- Runtime: Node for the daemon, Python for the device sidecar -----------
FROM node:24-alpine

# pymobiledevice3 lives in its own virtualenv so Alpine's system Python stays
# untouched. Pinned: device-protocol behaviour should only change on purpose.
ARG PYMOBILEDEVICE3_VERSION=11.63.1
RUN apk add --no-cache python3 tini \
 && python3 -m venv /opt/sidecar \
 && /opt/sidecar/bin/pip install --no-cache-dir "pymobiledevice3==${PYMOBILEDEVICE3_VERSION}"

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY sidecar ./sidecar

# pymobiledevice3 insists on creating a data folder under $HOME at start-up.
# Point it at /tmp so the container can run with a read-only root filesystem
# (mount /tmp as tmpfs). Nothing nightstand needs to keep is written there.
ENV HOME=/tmp \
    NODE_ENV=production \
    NIGHTSTAND_PYTHON=/opt/sidecar/bin/python \
    NIGHTSTAND_CONFIG=/config/nightstand.json \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# /config   nightstand.json and the pair records (secrets, mount read-only)
# /state    the SQLite database
# /backups  the backup dataset
VOLUME ["/state", "/backups"]

# Unprivileged: nothing here needs root, USB or host networking.
USER node

ENTRYPOINT ["/sbin/tini", "--", "node", "dist/cli.js"]
CMD ["daemon"]
