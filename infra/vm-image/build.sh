#!/usr/bin/env bash
# Builds the Wilson VM image from a laptop (README.md). Extra arguments go to `packer build`, for
# example `-var project_id=my-project`.
set -euo pipefail

cd "$(dirname "$0")"

for tool in packer gcloud; do
  if ! command -v "$tool" >/dev/null; then
    echo "$tool is not installed" >&2
    exit 1
  fi
done

# The engine version is the one this repository's probes passed on, so a bump moves the image too.
version_file=../../apps/api/src/modules/agent/cli.engine.version.ts
PKR_VAR_claude_code_version="$(sed -n "s/^export const CLAUDE_BINARY_VERSION = '\(.*\)';$/\1/p" "$version_file")"
if [[ -z "$PKR_VAR_claude_code_version" ]]; then
  echo "could not read CLAUDE_BINARY_VERSION from $version_file" >&2
  exit 1
fi
export PKR_VAR_claude_code_version

packer init .
packer build "$@" .
