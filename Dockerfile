# syntax=docker/dockerfile:1

# Wilson's orchestrator, as two images built from one tree:
#
#   docker build --target api .   The API and daemon: the board, the queue, placement, the tool guard,
#                                 verification and merges. Stages placed `remote` run on workers
#                                 (apps/worker); what still runs here is planning and any stage left
#                                 `local`.
#   docker build --target web .   The web app, served by nginx, which proxies /api to the API, so the
#                                 browser sees one origin.
#
# docker-compose.unraid.yml builds and runs both. The same pieces also come as one image, which is what
# the Unraid template (unraid/wilson.xml) installs:
#
#   docker build --target slim .  The API, the daemon and the web app in one container. Bring a
#                                 PostgreSQL 17 database.
#   docker build --target full .  The same with PostgreSQL inside it and its nightly backup.
#
# A worker, for a machine that runs stages, is a separate image with none of the above in use:
#
#   docker build --target worker . The worker program (apps/worker), the engine and git, connecting out
#                                 to Wilson. docker-compose.worker.yml runs it.
#
# Nothing here mounts or talks to the Docker socket, and nothing should: a stage's commands would then
# hold root on the host.

ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-bookworm-slim AS base
# git for the code repo and card branches, tini so the daemon gets signals and reaps its children.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
# pnpm, at the version package.json's packageManager names. From npm rather than corepack, which Node
# stopped shipping in 25.
RUN npm install -g pnpm@11.10.0 && npm cache clean --force
WORKDIR /opt/wilson

# Dependencies first, from the manifests alone, so a source change does not reinstall them.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/cli/package.json packages/cli/
COPY packages/sdk/package.json packages/sdk/
COPY packages/worker-protocol/package.json packages/worker-protocol/
COPY packages/config-eslint/package.json packages/config-eslint/
COPY packages/config-typescript/package.json packages/config-typescript/
# Every dependency, development ones included: the API runs its TypeScript through @swc-node/register
# and migrates with dbmate, both of which are development dependencies.
RUN pnpm install --frozen-lockfile

FROM deps AS source
COPY . .

FROM source AS web-build
# Read by Vite at build time. `/` is same-origin: the page calls whichever address it was loaded from.
ARG VITE_API_URL=/
RUN pnpm --filter @wilson/web exec vite build

FROM nginx:1.29-alpine AS web
# The image's entrypoint fills in ${API_UPSTREAM} from the environment, and nothing else in the file.
ENV API_UPSTREAM=api:13100
COPY deploy/web.nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=web-build /opt/wilson/apps/web/dist /usr/share/nginx/html

FROM source AS engine
# The engine binary the planning sessions and any `local` stage start, pinned to the version the engine
# probes last passed on (CLAUDE_BINARY_VERSION, apps/api/src/modules/agent/cli.engine.version.ts), so
# `wilson doctor`'s check agrees with it.
ARG CLAUDE_VERSION=2.1.246
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" && npm cache clean --force

FROM engine AS worker
# What the projects served here build with, beyond Node, pnpm and git: `--build-arg
# WORKER_PACKAGES="build-essential python3"`.
ARG WORKER_PACKAGES=""
RUN if [ -n "$WORKER_PACKAGES" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends $WORKER_PACKAGES \
        && rm -rf /var/lib/apt/lists/*; \
    fi
# A stage commits here, and the worker's user has no identity of its own. A system setting so that it
# holds whatever environment a command runs with.
RUN git config --system user.name Wilson && git config --system user.email wilson@localhost
# Where a host's projects go. Made here so that a new named volume starts out owned by the worker's user.
RUN install -d -o node -g node /srv/projects
VOLUME /srv/projects
# Not root, and the program under /opt stays root's, so a stage cannot rewrite what carries out its
# commands.
USER node
WORKDIR /opt/wilson/apps/worker
ENTRYPOINT ["tini", "--"]
# node directly, not `pnpm start`: the worker's exit status is how a supervisor tells a refusal from a
# crash, and SIGTERM has to reach it.
CMD ["node", "--import", "@swc-node/register/esm-register", "./src/main.ts"]

FROM engine AS api
# The runtime user is the compose file's choice (Unraid's nobody:users by default). Everything it must
# write is a mounted volume, so the image itself stays read-only to it.
WORKDIR /opt/wilson/apps/api
EXPOSE 13100
ENTRYPOINT ["tini", "--"]
# Migrations first, every start: dbmate applies only what is new, and the API refuses to run against a
# schema it does not match.
CMD ["sh", "-c", "./node_modules/.bin/dbmate -d ./data/migrations --no-dump-schema --wait up && exec node --import @swc-node/register/esm-register ./src/index.ts"]

# One container, one port, one /data. deploy/entrypoint.sh starts as root to set up /data, then drops
# to PUID:PGID; a blank DATABASE_HOST on `full` runs the database inside it.
FROM api AS slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx \
    && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled/default \
    && ln -sf /dev/stdout /var/log/nginx/access.log \
    && ln -sf /dev/stderr /var/log/nginx/error.log
COPY deploy/web.nginx.conf /etc/nginx/conf.d/wilson.conf
RUN sed -i 's/${API_UPSTREAM}/127.0.0.1:13100/' /etc/nginx/conf.d/wilson.conf
COPY --from=web-build /opt/wilson/apps/web/dist /usr/share/nginx/html
COPY deploy/entrypoint.sh /usr/local/bin/wilson-entrypoint
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
    CMD ["node", "-e", "fetch('http://127.0.0.1/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["tini", "--", "wilson-entrypoint"]
CMD []

FROM slim AS full
# 17, to match the compose stack; bookworm's own is 15. From PGDG, by its own setup script, and with
# no cluster made here: the entrypoint makes one under /data on first boot.
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-common \
    && sed -i 's/^#\?create_main_cluster.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf \
    && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
    && apt-get install -y --no-install-recommends postgresql-17 \
    && rm -rf /var/lib/apt/lists/*
