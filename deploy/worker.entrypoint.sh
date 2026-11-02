#!/bin/bash
# The `worker` image (Dockerfile): the test database, then the worker. It is the one `db-test` in
# docker-compose.yml is, on the same port and with the same names, so a project's suite finds it with no
# settings of its own. Never point anything you care about at it: every start begins again from empty.
set -euo pipefail

PGBIN=/usr/lib/postgresql/17/bin
CLUSTER=/var/lib/wilson-test-db
PORT=15533

find "$CLUSTER" -mindepth 1 -delete
"$PGBIN/initdb" --pgdata="$CLUSTER" --username=postgres --auth=trust --no-sync >/dev/null

# No socket directory: /run/postgresql is not this user's, and the suite connects over TCP. `localhost`
# rather than 127.0.0.1, because a client's `localhost` can resolve to ::1 first.
"$PGBIN/pg_ctl" --pgdata="$CLUSTER" --wait --timeout=120 --log="$CLUSTER/postgres.log" \
    --options="-p $PORT -c listen_addresses=localhost -c unix_socket_directories= -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
    start >/dev/null
"$PGBIN/createdb" --host=127.0.0.1 --port="$PORT" --username=postgres wilson_test

exec "$@"
