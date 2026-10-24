#!/usr/bin/env bash
# Runs the command before `--` on the arguments after it, adding the binary
# smoke suites when none of them names a test file or folder, so `bun run
# test:e2e` with no paths never runs the whole repo under the e2e lane limit.
set -euo pipefail

command=()

while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  command+=("$1")
  shift
done

[ "$#" -gt 0 ] && shift

named=false

for argument in "$@"; do
  if [ -e "$argument" ] || [[ "$argument" == *.test.ts ]]; then
    named=true
  fi
done

if [ "$named" = false ]; then
  set -- "$@" e2e/daemon-*.test.ts e2e/gateway-*.test.ts
fi

exec "${command[@]}" "$@"
