#!/usr/bin/env bash
# Rebuilds wilson.icns from brand/wilson-app-icon.svg. Run by hand when the mark changes: the .icns
# is committed so that packaging needs nothing but the .NET SDK.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
svg="$here/../../../../brand/wilson-app-icon.svg"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# qlmanage cannot do this: it flattens onto white and does not scale the SVG to the thumbnail. The
# tile sits at 824 of 1024 on a transparent canvas, the macOS icon grid, so Finder and the Dock
# size it like every other app and do not put it on a backing plate of their own.
swift - "$svg" "$work/icon.png" <<'SWIFT'
import AppKit

let canvas = 1024, tile = 824
guard let image = NSImage(contentsOfFile: CommandLine.arguments[1]) else { exit(1) }
let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: canvas, pixelsHigh: canvas, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let inset = (canvas - tile) / 2
image.draw(in: NSRect(x: inset, y: inset, width: tile, height: tile))
NSGraphicsContext.current?.flushGraphics()
try bitmap.representation(using: .png, properties: [:])!
    .write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
SWIFT

mkdir "$work/wilson.iconset"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$work/icon.png" --out "$work/wilson.iconset/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$work/icon.png" --out "$work/wilson.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns -o "$here/wilson.icns" "$work/wilson.iconset"
