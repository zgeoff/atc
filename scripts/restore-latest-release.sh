#!/usr/bin/env bash
# Leaves the latest mark on the newest published @zgeoff/atc release of
# <repo>, moving it there when another release holds it. A release that
# another branch creates can take the mark between a read and an edit, so it
# reads again after each edit.
#
#   scripts/restore-latest-release.sh <owner/repo>
set -euo pipefail

repo="$1"
scripts=$(cd "$(dirname "$0")" && pwd)

for attempt in 1 2 3 4 5 6; do
  releases=$(gh release list --repo "$repo" --exclude-drafts --exclude-pre-releases \
    --limit 10000 --json tagName,isLatest)
  newest=$(jq -r '.[].tagName' <<< "$releases" | sed -n 's/^@zgeoff\/atc@//p' |
    "$scripts/pick-newest-version.sh")

  if [ -z "$newest" ]; then
    exit 0
  fi

  latest=$(jq -r '.[] | select(.isLatest) | .tagName' <<< "$releases")

  if [ "$latest" = "@zgeoff/atc@$newest" ]; then
    exit 0
  fi

  if [ "$attempt" -eq 6 ]; then
    break
  fi

  gh release edit "@zgeoff/atc@$newest" --latest --repo "$repo"
done

echo "the latest mark did not settle on the newest release" >&2
exit 1
