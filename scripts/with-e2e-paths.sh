#!/usr/bin/env bash
# Runs the command before `--` on the test files after it, or on the binary
# smoke suites when none follows, so a bare `bun run test:e2e` never runs the
# whole repo under the e2e lane limit.
set -euo pipefail

command=()

while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  command+=("$1")
  shift
done

[ "$#" -gt 0 ] && shift

if [ "$#" -eq 0 ]; then
  set -- e2e/daemon-*.test.ts e2e/gateway-*.test.ts
fi

exec "${command[@]}" "$@"
