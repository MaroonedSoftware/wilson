#!/usr/bin/env bash
# Installs rcodesign (apple-codesign) on x86_64 Linux into the directory given, checked against a
# pinned hash, for `make-app-bundle.sh` to sign with where there is no `codesign`. On GitHub Actions
# it also puts that directory on the PATH of later steps.
set -euo pipefail

version=0.29.0
sha256=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002
name="apple-codesign-${version}-x86_64-unknown-linux-musl"

dir="${1:?usage: install-rcodesign.sh <directory>}"
mkdir -p "$dir"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/$name.tar.gz" "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${version}/${name}.tar.gz"
echo "${sha256}  $work/$name.tar.gz" | sha256sum --check --quiet
tar -xzf "$work/$name.tar.gz" -C "$work"
install -m 0755 "$work/$name/rcodesign" "$dir/rcodesign"
"$dir/rcodesign" --version

if [ -n "${GITHUB_PATH:-}" ]; then
    echo "$dir" >> "$GITHUB_PATH"
fi
