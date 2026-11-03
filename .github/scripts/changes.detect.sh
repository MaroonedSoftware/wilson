#!/usr/bin/env bash
# Says which path-scoped checks a pull request needs, so `pr.yml` can run them and count them in `ci-ok`.
# Not each workflow's own `paths` filter: `ci-ok` cannot wait on another workflow, and GitHub would
# hold a pull request forever on a required check whose workflow never started.
#
# With no BASE, as on the version pull request's dispatched run, it compares against main. The
# gating files are listed for both, so a change to how these checks start also runs them.
set -euo pipefail

base="${BASE:-origin/main}"
head="${HEAD:-HEAD}"
gating=(.github/workflows/pr.yml .github/scripts/changes.detect.sh)

# Not called inside $(...): bash drops `set -e` there, and a failed diff would read as nothing changed.
check() {
    local name="$1"
    shift
    local changed
    changed="$(git diff --name-only "$base...$head" -- "$@" "${gating[@]}")"
    if [ -n "$changed" ]; then
        echo "$name=true" >> "$GITHUB_OUTPUT"
    else
        echo "$name=false" >> "$GITHUB_OUTPUT"
    fi
}

check android apps/android apps/api/data/contracts packages/sdk-kotlin .github/workflows/android.yml
check desktop apps/desktop apps/android/app/src/test/resources/api apps/api/data/contracts packages/sdk-csharp .github/workflows/desktop.yml
