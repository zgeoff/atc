#!/usr/bin/env bash
# Runs the command before `--` on the arguments after it, adding the binary
# smoke suites when none of them is a test path or filter, so `bun run
# test:e2e` with only flags never runs the whole repo under the e2e lane limit.
set -euo pipefail

command=()

while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  command+=("$1")
  shift
done

[ "$#" -gt 0 ] && shift

# The `bun test --help` options whose value can follow as the next argument.
valued=" --timeout --rerun-each --retry --seed --coverage-reporter --coverage-dir -t --test-name-pattern --reporter --reporter-outfile --max-concurrency --path-ignore-patterns --parallel-delay --shard --timings --preload -r "

named=false
skip=false

for argument in "$@"; do
  if [ "$skip" = true ]; then
    skip=false
  elif [[ "$argument" == -* ]]; then
    [[ "$argument" != *=* && "$valued" == *" $argument "* ]] && skip=true
  else
    named=true
  fi
done

if [ "$named" = false ]; then
  set -- "$@" e2e/daemon-*.test.ts e2e/gateway-*.test.ts
fi

exec "${command[@]}" "$@"
