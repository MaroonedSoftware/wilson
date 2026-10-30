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
# docker-compose.unraid.yml builds and runs both. Nothing here mounts or talks to the Docker socket,
# and nothing should: a stage's commands would then hold root on the host.

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

FROM nginx:1.27-alpine AS web
# The image's entrypoint fills in ${API_UPSTREAM} from the environment, and nothing else in the file.
ENV API_UPSTREAM=api:13100
COPY deploy/web.nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=web-build /opt/wilson/apps/web/dist /usr/share/nginx/html

FROM source AS api
# The engine binary the planning sessions and any `local` stage start, pinned to the version the engine
# probes last passed on (CLAUDE_BINARY_VERSION, apps/api/src/modules/agent/cli.engine.version.ts), so
# `wilson doctor`'s check agrees with it.
ARG CLAUDE_VERSION=2.1.246
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" && npm cache clean --force
# The runtime user is the compose file's choice (Unraid's nobody:users by default). Everything it must
# write is a mounted volume, so the image itself stays read-only to it.
WORKDIR /opt/wilson/apps/api
EXPOSE 13100
ENTRYPOINT ["tini", "--"]
# Migrations first, every start: dbmate applies only what is new, and the API refuses to run against a
# schema it does not match.
CMD ["sh", "-c", "./node_modules/.bin/dbmate -d ./data/migrations --no-dump-schema --wait up && exec node --import @swc-node/register/esm-register ./src/index.ts"]
