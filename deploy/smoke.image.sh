#!/usr/bin/env bash
# Boots a `full` image the way a first install on Unraid does, on an empty /data with a project clone
# mounted, and waits for the API to answer through nginx: the entrypoint makes the embedded database,
# migrates it, and starts both services. Then checks nginx serves the web app, deep links included.
# CI runs it on the image a pull request builds; locally:
#
#   docker build --target full -t wilson:smoke .
#   deploy/smoke.image.sh wilson:smoke
#
# It needs no database, no engine token and no network beyond the host port it publishes.
set -euo pipefail

image="${1:?usage: smoke.image.sh <image>}"
container="wilson-smoke-$$"
port="${SMOKE_PORT:-13190}"
workdir="$(mktemp -d)"

cleanup() {
    docker rm -f -v "$container" >/dev/null 2>&1 || true
    rm -rf "$workdir"
}
trap cleanup EXIT

# The clone the entrypoint insists on. A real one, since the API reads its HEAD at boot.
git init -q -b main "$workdir/wilson"
git -C "$workdir/wilson" -c user.name=Smoke -c user.email=smoke@wilson.test commit -q --allow-empty -m smoke
chmod -R a+rX "$workdir"

echo "Starting $image"
docker run -d --name "$container" -p "$port:80" -v "$workdir/wilson:/projects/wilson" "$image" >/dev/null

# Generous, for the first boot's initdb and every migration on a two-core runner.
for _ in $(seq 120); do
    if health="$(curl -fsS "http://localhost:$port/api/health" 2>/dev/null)"; then
        break
    fi
    health=
    if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]; then
        echo "$container exited"
        break
    fi
    sleep 1
done

if [ -z "$health" ]; then
    echo "/api/health never answered; the container's log:"
    docker logs "$container"
    exit 1
fi
echo "$health"
grep -q '"ok":true' <<<"$health" || { echo "/api/health is not ok"; exit 1; }

# The SPA, and a deep link the router draws rather than a file nginx has.
curl -fsS "http://localhost:$port/" | grep -q '<div id="root">' || { echo "/ is not the SPA"; exit 1; }
curl -fsS "http://localhost:$port/projects/wilson" | grep -q '<div id="root">' || { echo "A deep link is not the SPA"; exit 1; }
echo "Image ready"
