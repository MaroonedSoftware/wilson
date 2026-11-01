#!/usr/bin/env bash
# Fails a pull request that changes what the desktop app ships without adding a changeset, because
# such a change would merge and then never reach a release, with nothing to say so.
set -euo pipefail

if [ "${BRANCH:-}" = changeset-release/desktop ]; then
    exit 0
fi

changed="$(git diff --name-only "$BASE...$HEAD" -- apps/desktop/src apps/desktop/tools/macos)"
if [ -z "$changed" ]; then
    exit 0
fi

if git diff --name-only --diff-filter=A "$BASE...$HEAD" -- '.changeset/*.md' | grep -qv README; then
    exit 0
fi

echo "$changed"
echo "::error::This changes the desktop app and adds no changeset. Run pnpm changeset, or pnpm changeset --empty if it should not ship."
exit 1
