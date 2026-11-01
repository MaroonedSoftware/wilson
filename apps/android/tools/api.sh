#!/usr/bin/env bash
# A throwaway Wilson API for the emulator, at http://10.0.2.2:13150 from inside it. It uses its own
# database on the tmpfs `db-test` server and its own folders, so it can never touch the real board,
# and the poller is off so nothing it holds ever starts work. Runs in the foreground.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STATE="${TMPDIR:-/tmp}/wilson-android-api"
PORT="${ANDROID_API_PORT:-13150}"
mkdir -p "$STATE/worktrees" "$STATE/run" "$STATE/secrets"

cd "$ROOT/apps/api"
if [ ! -x node_modules/.bin/dbmate ]; then
    echo "node_modules is missing: run pnpm install at the repo root" >&2
    exit 1
fi

export DATABASE_HOST=localhost DATABASE_PORT=15533 DATABASE_USER=postgres DATABASE_PASSWORD=postgres
export DATABASE_NAME=wilson_android
export DATABASE_URL="postgres://postgres:postgres@localhost:15533/wilson_android?sslmode=disable"
export PORT PROJECT_NAME=wilson POLLER_ENABLED=false
export PROJECT_CODE_ROOT="$ROOT" PROJECT_WORKTREE_ROOT="$STATE/worktrees" PROJECT_RUN_ROOT="$STATE/run"
export AUTH_SESSION_KEY_FILE="$STATE/secrets/session.pem" AUTH_ENCRYPTION_KEY_FILE="$STATE/secrets/encryption.key"
unset ANTHROPIC_API_KEY

./node_modules/.bin/dbmate -d ./data/migrations --no-dump-schema --wait up
exec node --import @swc-node/register/esm-register ./src/index.ts
