#!/usr/bin/env bash
# Creates the key that signs desktop updates. Run once, by a person.
#
# The private half goes straight to the UPDATE_SIGNING_KEY repository secret and is never written to
# disk. The public half is written into Core, to be committed. Replacing the key cuts off every
# installed copy, which would then refuse updates and need installing by hand, so this refuses to run
# if a key exists.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
public="$here/../../src/MaroonedSoftware.Wilson.Desktop.Core/Updates/update-key.pem"
if [ -e "$public" ]; then
    echo "$public already exists, and replacing it strands every installed copy" >&2
    exit 1
fi

private="$(openssl ecparam -name prime256v1 -genkey -noout)"
printf '%s\n' "$private" | gh secret set UPDATE_SIGNING_KEY --repo MaroonedSoftware/wilson
printf '%s\n' "$private" | openssl ec -pubout -out "$public" 2>/dev/null
echo "UPDATE_SIGNING_KEY is set. Commit $public"
