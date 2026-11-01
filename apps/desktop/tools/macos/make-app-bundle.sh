#!/usr/bin/env bash
# Builds Wilson.app for Apple Silicon, signed ad hoc, in apps/desktop/artifacts.
#
# Not `PublishTrimmed`: the generated SDK reads JSON by reflection, which the trimmer cannot see. Not
# `IncludeNativeLibrariesForSelfExtract`, which fails at run time on macOS. Deadair's script explains
# each signing step in full, and any change here should be read against it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
version="${1:-$(dotnet msbuild "$root/Directory.Build.props" -getProperty:Version 2>/dev/null | tr -d '[:space:]')}"
if [ -z "$version" ]; then
    echo "could not read Version from Directory.Build.props, and none was given" >&2
    exit 1
fi

out="$root/artifacts"
app="$out/Wilson.app"

# The publish directory too: publish deletes nothing, so a stale file would ship.
rm -rf "$app" "$out/publish"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

dotnet publish "$root/src/MaroonedSoftware.Wilson.Desktop" \
    --configuration Release \
    --runtime osx-arm64 \
    --self-contained true \
    -p:PublishTrimmed=false \
    -p:PublishSingleFile=false \
    -p:Version="$version" \
    --output "$out/publish"

cp -R "$out/publish/." "$app/Contents/MacOS/"
cp "$here/wilson.icns" "$app/Contents/Resources/"
sed "s/__VERSION__/$version/g" "$here/Info.plist.in" > "$app/Contents/Info.plist"
chmod +x "$app/Contents/MacOS/wilson"

# Innermost first, then the bundle. Every file under MacOS, because codesign treats them all as code.
# Hardened runtime throughout, so anything that would fail notarisation fails here first.
find "$app/Contents/MacOS" -type f ! -path "$app/Contents/MacOS/wilson" -print0 \
    | xargs -0 codesign --force --options runtime --sign -
codesign --force --options runtime --entitlements "$here/wilson.entitlements" --sign - "$app"
codesign --verify --strict --verbose=2 "$app"

signature="$(codesign --display --verbose=2 "$app" 2>&1)"
if ! grep -q '^CodeDirectory.*flags=.*runtime' <<< "$signature"; then
    echo "the bundle is not signed with the hardened runtime" >&2
    exit 1
fi

echo "built $app"
