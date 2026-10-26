#!/usr/bin/env bash
# Exits 0 when a release of <version> may write the Homebrew formula at
# <formula>: the file is missing, or it holds the same or an older version.
# Exits 1 when the formula holds a newer version, so a patch release from a
# release branch never moves the formula back.
#
#   scripts/should-write-formula.sh <formula> <version>
set -euo pipefail

formula="$1"
version="$2"

current=""

if [ -f "$formula" ]; then
  current=$(sed -n 's/^[[:space:]]*version "\([^"]*\)"$/\1/p' "$formula")
fi

if [ -z "$current" ]; then
  exit 0
fi

newest=$(printf '%s\n%s\n' "$current" "$version" | "$(dirname "$0")/pick-newest-version.sh")

if [ "$newest" = "$version" ]; then
  exit 0
fi

echo "the formula holds $current, newer than $version; left as it is"
exit 1
