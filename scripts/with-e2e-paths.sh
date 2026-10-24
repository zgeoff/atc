#!/usr/bin/env bash
# Runs the command before `--` on the e2e test files after it, or on the
# binary smoke suites when none follows. It takes only files under e2e/ and
# refuses anything else, flags included, so `bun run test:e2e` never runs a
# test outside e2e/ under the e2e lane limit.
set -euo pipefail

command=()

while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  command+=("$1")
  shift
done

[ "$#" -gt 0 ] && shift

root="$(pwd -P)/e2e/"

for argument in "$@"; do
  if [[ "$argument" != *.test.ts || ! -f "$argument" ||
    "$(cd "$(dirname "$argument")" && pwd -P)/" != "$root"* ]]; then
    echo "with-e2e-paths: $argument is not a test file under e2e/; pass only e2e test files" >&2
    exit 2
  fi
done

if [ "$#" -eq 0 ]; then
  set -- e2e/daemon-*.test.ts e2e/gateway-*.test.ts
fi

exec "${command[@]}" "$@"
