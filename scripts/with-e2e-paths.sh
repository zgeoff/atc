#!/usr/bin/env bash
# Runs the command before `--` on the arguments after it, adding the binary
# smoke suites when none of them is a path under e2e/, so `bun run test:e2e`
# with no paths or only flags never runs the whole repo under the e2e lane limit.
set -euo pipefail

command=()

while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  command+=("$1")
  shift
done

[ "$#" -gt 0 ] && shift

# Only an argument under e2e/ counts as a path, so a flag, its value, or a
# filter outside e2e/ never stops the run from taking the e2e suites.
named=false

for argument in "$@"; do
  if [[ "$argument" == e2e/* || "$argument" == ./e2e/* ]]; then
    named=true
  fi
done

if [ "$named" = false ]; then
  set -- "$@" e2e/daemon-*.test.ts e2e/gateway-*.test.ts
fi

exec "${command[@]}" "$@"
