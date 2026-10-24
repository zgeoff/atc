#!/usr/bin/env bash
# Runs the command before `--` on the arguments after it, adding the binary
# smoke suites when no argument is a path or path filter (one holding a `/` or
# ending `.ts`), so `bun run test:e2e` with only flags never runs the whole
# repo under the e2e lane limit.
set -euo pipefail

command=()

while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  command+=("$1")
  shift
done

[ "$#" -gt 0 ] && shift

named=false

for argument in "$@"; do
  if [[ "$argument" != -* && ("$argument" == */* || "$argument" == *.ts) ]]; then
    named=true
  fi
done

if [ "$named" = false ]; then
  set -- "$@" e2e/daemon-*.test.ts e2e/gateway-*.test.ts
fi

exec "${command[@]}" "$@"
