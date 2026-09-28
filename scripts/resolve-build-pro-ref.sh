#!/usr/bin/env bash
set -euo pipefail
# An explicit dispatch override wins; otherwise use this Core commit's gitlink.
ref=${PRO_BUILD_REF:-}
if [[ -z "$ref" ]]; then
  ref=$(git ls-tree HEAD pro | awk '$1 == "160000" { print $3 }')
  [[ "$ref" =~ ^[0-9a-f]{40}$ ]] || { echo 'Core has no pinned Pro commit; supply pro_ref.' >&2; exit 1; }
fi
[[ "$ref" != *$'\n'* && "$ref" != *$'\r'* ]] || { echo 'Invalid Pro ref' >&2; exit 1; }
printf 'ref=%s\n' "$ref" >> "$GITHUB_OUTPUT"
