#!/usr/bin/env bash
# Removes old builds of Wilson's image from a host, so that a deploy has room to pull. Each deploy
# leaves one behind, about 1.6 GB, and on Unraid they share a fixed-size disk with every other
# container. Keeps any image a container uses, and the newest few `slim-<sha>` tags as rollbacks. Also
# removes this image's untagged builds, which pulling `slim` leaves behind and nothing can pull by name.
# It removes images one at a time and deliberately runs no `docker prune`: a volume can hold data with
# no container attached, and other projects' untagged images are not this script's to judge.
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

# `$2 == image`, because the filter answers for every image on the host.
for id in $(docker images --filter dangling=true --no-trunc --format '{{.ID}} {{.Repository}}' | awk -v image="$IMAGE" '$2 == image { print $1 }'); do
    if grep -qxF "$id" <<<"$in_use"; then
        echo "in use: $id"
    elif [ -n "$DRY_RUN" ]; then
        echo "would remove: $id"
    else
        docker rmi "$id" >/dev/null && echo "removed: $id" || echo "could not remove: $id"
    fi
done
