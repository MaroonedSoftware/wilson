#!/usr/bin/env bash
# Rebuilds the menu-bar icon from brand/wilson-mark-16.svg, the mark's hinted variant for this size.
# Run by hand when the mark changes: the PNG is committed so that building needs only the .NET SDK.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
svg="$here/../../../../brand/wilson-mark-16.svg"
out="$here/../../src/MaroonedSoftware.Wilson.Desktop/Assets/tray.png"
mkdir -p "$(dirname "$out")"

# Black on clear, because macOS uses only the alpha of a template image and picks the colour itself.
# Avalonia scales the image to the height of the menu bar, 22pt, so the 18pt mark is padded inside it.
swift - "$svg" "$out" <<'SWIFT'
import AppKit

let canvas = 44, mark = 36
guard let image = NSImage(contentsOfFile: CommandLine.arguments[1]) else { exit(1) }
let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: canvas, pixelsHigh: canvas, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let inset = (canvas - mark) / 2
image.draw(in: NSRect(x: inset, y: inset, width: mark, height: mark))
NSGraphicsContext.current?.flushGraphics()
try bitmap.representation(using: .png, properties: [:])!
    .write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
SWIFT
