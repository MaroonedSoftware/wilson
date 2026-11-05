#!/usr/bin/env bash
# Builds Wilson.app for Apple Silicon, signed ad hoc, in apps/desktop/artifacts.
#
# Signs with Apple's `codesign` where there is one and `rcodesign` (apple-codesign) elsewhere, so a
# release can be built on Linux. `SIGNER=rcodesign` picks it on a Mac too, to try that path here.
#
# A single file (`PublishSingleFile` in the app's project), so that Contents/MacOS holds only Mach-O. `codesign` signs any other file there by
# writing extended attributes, which only `ditto` carries through a zip, and `rcodesign` cannot sign
# one at all. Native libraries stay beside it: `IncludeNativeLibrariesForSelfExtract` fails at run
# time on macOS. Not `PublishTrimmed`: the generated SDK reads JSON by reflection, which the trimmer
# cannot see. Deadair's script explains each signing step in full, and any change here should be read
# against it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
version="${1:-$(dotnet msbuild "$root/Directory.Build.props" -getProperty:Version 2>/dev/null | tr -d '[:space:]')}"
if [ -z "$version" ]; then
    echo "could not read Version from Directory.Build.props, and none was given" >&2
    exit 1
fi

if [ -z "${SIGNER:-}" ]; then
    if command -v codesign > /dev/null; then SIGNER=codesign; else SIGNER=rcodesign; fi
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
    -p:DebugType=embedded \
    -p:Version="$version" \
    --output "$out/publish"

cp -R "$out/publish/." "$app/Contents/MacOS/"
cp "$here/wilson.icns" "$app/Contents/Resources/"
sed "s/__VERSION__/$version/g" "$here/Info.plist.in" > "$app/Contents/Info.plist"
chmod +x "$app/Contents/MacOS/wilson"

# Whichever signer, a file that is not Mach-O here would ship unsigned or not at all.
while IFS= read -r -d '' file; do
    if ! file -b "$file" | grep -q '^Mach-O'; then
        echo "${file#"$app/"} is not Mach-O, so it cannot be signed as code in Contents/MacOS" >&2
        exit 1
    fi
done < <(find "$app/Contents/MacOS" -type f -print0)

# Hardened runtime throughout, so anything that would fail notarisation fails here first.
case "$SIGNER" in
    codesign)
        # Innermost first, then the bundle.
        find "$app/Contents/MacOS" -type f ! -path "$app/Contents/MacOS/wilson" -print0 \
            | xargs -0 codesign --force --options runtime --sign -
        codesign --force --options runtime --entitlements "$here/wilson.entitlements" --sign - "$app"
        codesign --verify --strict --verbose=2 "$app"

        signature="$(codesign --display --verbose=2 "$app" 2>&1)"
        if ! grep -q '^CodeDirectory.*flags=.*runtime' <<< "$signature"; then
            echo "the bundle is not signed with the hardened runtime" >&2
            exit 1
        fi
        ;;
    rcodesign)
        # Ad hoc, as no key is given. One pass signs the libraries and then the bundle, and a flag
        # given without a path reaches only the main executable, so each library is named.
        flags=(--code-signature-flags runtime --entitlements-xml-file "$here/wilson.entitlements")
        while IFS= read -r -d '' file; do
            flags+=(--code-signature-flags "${file#"$app/"}:runtime")
        done < <(find "$app/Contents/MacOS" -type f ! -path "$app/Contents/MacOS/wilson" -print0)
        rcodesign sign "${flags[@]}" "$app"

        # No `codesign --verify` off a Mac. Each signature, fat slices included, must be ad hoc
        # under the hardened runtime, which is what rcodesign itself reports.
        info="$(rcodesign print-signature-info "$app")"
        signed="$(grep -c 'flags: CodeSignatureFlags(' <<< "$info" || true)"
        hardened="$(grep -c 'flags: CodeSignatureFlags(.*RUNTIME' <<< "$info" || true)"
        if [ "$signed" -eq 0 ] || [ "$signed" -ne "$hardened" ]; then
            echo "a signature in the bundle lacks the hardened runtime" >&2
            exit 1
        fi
        ;;
    *)
        echo "SIGNER must be codesign or rcodesign, not $SIGNER" >&2
        exit 1
        ;;
esac

echo "built $app"
