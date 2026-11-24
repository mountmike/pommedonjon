# syntax=docker/dockerfile:1

# --- Build the server and the web app from the workspace ---------------------
FROM node:26-alpine AS build
WORKDIR /repo
RUN npm install --global pnpm@12
# Dependencies first, from the manifests alone, so that changing the source
# does not install them again. Every workspace's package.json has to be here
# for the lockfile to be accepted: add a line when a workspace is added.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/app/package.json apps/app/
COPY packages/api-contract/package.json packages/api-contract/
COPY tools/deploy/package.json tools/deploy/
RUN pnpm install --frozen-lockfile --filter "pommedonjon..." --filter "@pommedonjon/app..."
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/server apps/server
# The server and the workspace packages it depends on, in that order.
RUN pnpm --filter "pommedonjon..." build
# The app, exported as a website for the server to serve.
COPY apps/app apps/app
RUN CI=1 EXPO_NO_TELEMETRY=1 pnpm --filter @pommedonjon/app build
# A self-contained copy of the server: its build output, the sidecar, and
# only the dependencies it needs at run time.
RUN pnpm --filter pommedonjon deploy --prod /out

# --- Runtime: Node for the daemon, Python for the device sidecar -----------
FROM node:26-alpine

# pymobiledevice3 lives in its own virtualenv so Alpine's system Python stays
# untouched. Pinned: device-protocol behaviour should only change on purpose.
ARG PYMOBILEDEVICE3_VERSION=11.63.1
RUN apk add --no-cache python3 tini \
 && python3 -m venv /opt/sidecar \
 && /opt/sidecar/bin/pip install --no-cache-dir "pymobiledevice3==${PYMOBILEDEVICE3_VERSION}"

WORKDIR /app
COPY --from=build /out ./
# The web app, beside the server, which serves it at the API's own address.
COPY --from=build /repo/apps/app/dist ./web

# The commit this image was built from, shown by --version and in the
# start-up log. Set by the build pipeline; "dev" for a local build.
ARG POMMEDONJON_BUILD=dev

# pymobiledevice3 insists on creating a data folder under $HOME at start-up.
# Point it at /tmp so the container can run with a read-only root filesystem
# (mount /tmp as tmpfs). Nothing pommedonjon needs to keep is written there.
ENV HOME=/tmp \
    NODE_ENV=production \
    POMMEDONJON_PYTHON=/opt/sidecar/bin/python \
    POMMEDONJON_CONFIG=/config/pommedonjon.json \
    POMMEDONJON_BUILD=${POMMEDONJON_BUILD} \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# /config        pommedonjon.json (mount read-only)
# /run/secrets   one pair record per phone (mount read-only)
# /state         the SQLite database; a local disk
# /backups       where backups live
# Owned by the user the image runs as, so that a fresh named volume, which
# Docker initialises from these directories, is writable from the first run.
RUN mkdir -p /state /backups && chown node:node /state /backups
VOLUME ["/state", "/backups"]

# Unprivileged: nothing here needs root, USB or host networking.
USER node

ENTRYPOINT ["/sbin/tini", "--", "node", "dist/cli.js"]
CMD ["daemon"]
