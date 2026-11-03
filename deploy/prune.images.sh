#!/usr/bin/env bash
# Removes old `slim-<sha>` tags of Wilson's image from a host, so that a deploy has room to pull. Each
# deploy leaves one behind, about 1.6 GB, and on Unraid they share a fixed-size disk with every other
# container. Keeps any tag a container uses, and the newest few as rollbacks. It removes tags by name
# and deliberately runs no `docker prune`: a volume can hold data with no container attached.
#
#   ssh root@192.168.1.69 'DRY_RUN=1 bash -s' < deploy/prune.images.sh
#   ssh root@192.168.1.69 'bash -s' < deploy/prune.images.sh
set -euo pipefail

IMAGE=${IMAGE:-ghcr.io/maroonedsoftware/wilson}
KEEP=${KEEP:-2}
DRY_RUN=${DRY_RUN:-}

# Full ids, since `docker images` and `docker inspect` agree on nothing shorter.
in_use=$(docker ps -a --format '{{.ID}}' | xargs -r docker inspect --format '{{.Image}}' | sort -u)

kept=0
# `docker images` lists newest first.
for ref in $(docker images "$IMAGE" --format '{{.Repository}}:{{.Tag}}' | grep -E ':slim-[0-9a-f]+$' || true); do
    id=$(docker inspect "$ref" --format '{{.Id}}')
    if grep -qxF "$id" <<<"$in_use"; then
        echo "in use: $ref"
    elif [ "$kept" -lt "$KEEP" ]; then
        kept=$((kept + 1))
        echo "kept: $ref"
    elif [ -n "$DRY_RUN" ]; then
        echo "would remove: $ref"
    else
        # No -f: if something started using it just now, docker refuses and this says so.
        docker rmi "$ref" >/dev/null && echo "removed: $ref" || echo "could not remove: $ref"
    fi
done
