#!/bin/bash
# Wilson as one container: the `full` and `slim` images (Dockerfile). Starts as root to set up /data,
# then runs everything as PUID:PGID. Each piece is still its own process, and nothing restarts one:
# if any of them stops, the container stops and its restart policy brings the whole thing back, which
# is the one recovery a daemon holding stages needs anyway.
set -euo pipefail

DATA=/data
API_DIR=/opt/wilson/apps/api
PGBIN=/usr/lib/postgresql/17/bin
CLUSTER="$DATA/postgres"

die() {
    echo "wilson: $*" >&2
    exit 1
}

# Unraid hands a blank form field over as an empty variable. Empty is not unset to everything this
# starts: an empty CLAUDE_CODE_OAUTH_TOKEN is still a token, and the engine would not fall back.
for name in $(compgen -e); do
    [ -n "${!name}" ] || unset "$name"
done

export PUID="${PUID:-99}" PGID="${PGID:-100}"
export PROJECT_NAME="${PROJECT_NAME:-wilson}"
export PROJECT_CODE_ROOT="${PROJECT_CODE_ROOT:-/projects/$PROJECT_NAME}"
export PROJECT_WORKTREE_ROOT="$DATA/worktrees" PROJECT_RUN_ROOT="$DATA/run" PROJECT_BROWSE_ROOT=/projects
export AUTH_SESSION_KEY_FILE="$DATA/secrets/session.pem" AUTH_ENCRYPTION_KEY_FILE="$DATA/secrets/encryption.key"
export CLAUDE_CONFIG_DIR="$DATA/claude" HOME="$DATA/home" WILSON_BACKUP_DIR="$DATA/backups"
export GITHUB_APP_PRIVATE_KEY_FILE="$DATA/secrets/github-app.pem"
export PORT=13100
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Wilson}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-wilson@localhost}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-Wilson}" GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-wilson@localhost}"
# A mounted clone belongs to whoever cloned it, which git otherwise refuses to work in.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'

# initdb and git both ask who they are, so PUID needs a name. -o: Unraid's 99:100 may be taken.
groupadd -o -f -g "$PGID" wilson
id wilson >/dev/null 2>&1 || useradd -K UID_MIN=0 -o -u "$PUID" -g "$PGID" -d "$HOME" -M -s /usr/sbin/nologin wilson
as_wilson() { setpriv --reuid="$PUID" --regid="$PGID" --init-groups "$@"; }

# Not recursive: only the folders themselves are this step's, so it stays quick however much is in them.
mkdir -p "$DATA"/{worktrees,run,secrets,claude,home,backups}
chown "$PUID:$PGID" "$DATA" "$DATA"/{worktrees,run,secrets,claude,home,backups}
chmod 700 "$DATA/secrets"

if [ ! -d "$PROJECT_CODE_ROOT" ]; then
    [ -n "${PROJECT_GIT_URL:-}" ] || die "no clone at $PROJECT_CODE_ROOT: mount one there, or set PROJECT_GIT_URL"
    mkdir -p "$(dirname "$PROJECT_CODE_ROOT")"
    chown "$PUID:$PGID" "$(dirname "$PROJECT_CODE_ROOT")"
    echo "wilson: cloning the project into $PROJECT_CODE_ROOT"
    as_wilson git clone "$PROJECT_GIT_URL" "$PROJECT_CODE_ROOT"
fi

children=()

stop() {
    trap - TERM INT EXIT
    if [ "${#children[@]}" -gt 0 ]; then
        kill "${children[@]}" 2>/dev/null || true
        wait "${children[@]}" 2>/dev/null || true
    fi
    # Last, so the API can finish with it.
    if [ -n "${embedded:-}" ]; then
        as_wilson "$PGBIN/pg_ctl" --pgdata="$CLUSTER" --mode=fast --wait stop || true
    fi
}
trap 'stop; exit 0' TERM INT
trap stop EXIT

start_embedded_database() {
    embedded=1
    mkdir -p "$CLUSTER" /run/postgresql
    chown "$PUID:$PGID" "$CLUSTER" /run/postgresql
    chmod 700 "$CLUSTER"

    local password_file="$DATA/secrets/database.password"
    if [ ! -s "$password_file" ]; then
        as_wilson sh -c "umask 077; od -An -tx1 -N24 /dev/urandom | tr -d ' \n' > '$password_file'"
    fi

    local first_boot=
    if [ ! -s "$CLUSTER/PG_VERSION" ]; then
        first_boot=1
        echo 'wilson: no database yet; creating one'
        # `postgres` rather than `wilson`: a role named after the schema makes the schema the first
        # place unqualified names resolve, and migrations create that schema part way through.
        as_wilson "$PGBIN/initdb" --pgdata="$CLUSTER" --username=postgres --auth-local=trust \
            --auth-host=scram-sha-256 --pwfile="$password_file" --encoding=UTF8 >&2
        printf "\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = '/run/postgresql'\n" >>"$CLUSTER/postgresql.conf"
    fi

    as_wilson "$PGBIN/pg_ctl" --pgdata="$CLUSTER" --wait --timeout=120 --log="$DATA/postgres.log" start >&2
    if [ -n "$first_boot" ]; then
        as_wilson "$PGBIN/createdb" --host=/run/postgresql --username=postgres wilson
    fi

    export DATABASE_HOST=127.0.0.1 DATABASE_PORT=5432 DATABASE_USER=postgres DATABASE_NAME=wilson
    DATABASE_PASSWORD="$(cat "$password_file")"
    export DATABASE_PASSWORD
    unset DATABASE_URL
}

# The same nightly `pg_dump -Fc` as the compose files' `backup`, at 03:00 in TZ.
backup_loop() {
    export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD="$DATABASE_PASSWORD" PGDATABASE=wilson
    while true; do
        if [ "$(date +%H:%M)" = 03:00 ]; then
            target="$WILSON_BACKUP_DIR/wilson-$(date +%F).dump"
            if [ ! -f "$target" ]; then
                "$PGBIN/pg_dump" -Fc -f "$target.tmp"
                mv "$target.tmp" "$target"
                find "$WILSON_BACKUP_DIR" -maxdepth 1 -name 'wilson-*.dump' -mtime +14 -delete
            fi
        fi
        sleep 30
    done
}

if [ -z "${DATABASE_HOST:-}" ]; then
    [ -x "$PGBIN/postgres" ] || die 'no database: the slim image needs DATABASE_HOST, or use the full image'
    start_embedded_database
    export -f backup_loop
    export PGBIN
    as_wilson bash -c backup_loop &
    children+=($!)
else
    [ -n "${DATABASE_USER:-}" ] || die 'DATABASE_HOST is set, so DATABASE_USER is needed too'
    [ -n "${DATABASE_PASSWORD:-}" ] || die 'DATABASE_HOST is set, so DATABASE_PASSWORD is needed too'
    export DATABASE_PORT="${DATABASE_PORT:-5432}" DATABASE_NAME="${DATABASE_NAME:-wilson}"
fi

if [ -z "${DATABASE_URL:-}" ]; then
    DATABASE_URL="$(node -e "
        const { DATABASE_USER: u, DATABASE_PASSWORD: p, DATABASE_HOST: h, DATABASE_PORT: o, DATABASE_NAME: n, DATABASE_SSLMODE: s } = process.env;
        console.log('postgres://' + encodeURIComponent(u) + ':' + encodeURIComponent(p) + '@' + h + ':' + o + '/' + n + '?sslmode=' + (s ?? 'disable'));
    ")"
    export DATABASE_URL
fi

cd "$API_DIR"
# Migrations first, every start: dbmate applies only what is new, and the API refuses to run against a
# schema it does not match.
as_wilson ./node_modules/.bin/dbmate -d ./data/migrations --no-dump-schema --wait up

as_wilson node --import @swc-node/register/esm-register ./src/index.ts &
children+=($!)
nginx -g 'daemon off;' &
children+=($!)

set +e
wait -n
status=$?
echo "wilson: a service stopped (exit $status); stopping the container" >&2
exit "$((status == 0 ? 1 : status))"
