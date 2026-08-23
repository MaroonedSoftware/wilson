#!/usr/bin/env bash
# Roll every migration back, one at a time, until dbmate reports none applied.
set -euo pipefail
cd "$(dirname "$0")/.."
while dbmate -d ./data/migrations --no-dump-schema status 2>/dev/null | grep -q '^\[X\]'; do
    dbmate -d ./data/migrations --no-dump-schema down
done
