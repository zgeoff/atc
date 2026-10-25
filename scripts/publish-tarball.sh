#!/usr/bin/env bash
# Publishes a packed npm tarball with provenance, at the name and version its manifest holds:
#   publish-tarball.sh <tarball>
# A version npm holds already is skipped, so a re-run of the release job passes.
set -euo pipefail

usage='usage: publish-tarball.sh <tarball>'
if ! args=$(getopt --name publish-tarball.sh --options '' -- "$@"); then
  echo "$usage" >&2
  exit 2
fi
eval set -- "$args"
shift
if (($# != 1)); then
  echo "$usage" >&2
  exit 2
fi

tarball=$1
packed=$(tar -xzOf "$tarball" package/package.json)
name=$(jq -r .name <<< "$packed")
version=$(jq -r .version <<< "$packed")

if [[ $(npm view "$name@$version" version 2> /dev/null) == "$version" ]]; then
  echo "$name@$version is on npm already"
  exit 0
fi
npm publish "$tarball" --access public --provenance
