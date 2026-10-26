#!/usr/bin/env bash
# Writes the Homebrew formula for <version> to the tap at <tap url>, cloned
# into ./tap, and pushes it. Each branch's release pushes to the one tap, so
# a push that another release beat clones the tap and checks the version again.
#
#   scripts/update-tap-formula.sh <tap url> <version> <path to SHA256SUMS>
set -euo pipefail

url="$1"
version="$2"
sums="$3"
scripts=$(cd "$(dirname "$0")" && pwd)
tap="$PWD/tap"

for _ in 1 2 3 4 5; do
  rm -rf "$tap"
  git clone -q "$url" "$tap"

  if ! "$scripts/should-write-formula.sh" "$tap/Formula/atc.rb" "$version"; then
    exit 0
  fi

  mkdir -p "$tap/Formula"
  "$scripts/build-formula.sh" "$version" "$sums" > "$tap/Formula/atc.rb"
  git -C "$tap" add Formula/atc.rb
  git -C "$tap" -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit -q -m "atc $version" || echo "formula already at $version"

  if git -C "$tap" push -q; then
    exit 0
  fi
done

echo "the tap push failed 5 times" >&2
exit 1
