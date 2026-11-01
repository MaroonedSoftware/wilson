#!/usr/bin/env bash
# Rebuilds wilson.icns from brand/wilson-mark.svg. Run by hand when the mark changes: the .icns is
# committed so that packaging needs nothing but the .NET SDK.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
svg="$here/../../../../brand/wilson-mark.svg"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

qlmanage -t -s 1024 -o "$work" "$svg" >/dev/null
mkdir "$work/wilson.iconset"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$work/wilson-mark.svg.png" --out "$work/wilson.iconset/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$work/wilson-mark.svg.png" --out "$work/wilson.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns -o "$here/wilson.icns" "$work/wilson.iconset"
