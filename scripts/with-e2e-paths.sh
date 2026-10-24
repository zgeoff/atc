#!/usr/bin/env bash
# Runs the command before `--` on the arguments after it, adding the binary
# smoke suites when no e2e test file follows. It takes only e2e test files and
# the `bun test` options listed below, and refuses anything else, so `bun run
# test:e2e` never runs a test outside e2e/ under the e2e lane limit.
set -euo pipefail

command=()

while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  command+=("$1")
  shift
done

[ "$#" -gt 0 ] && shift

refuse() {
  echo "with-e2e-paths: $1 is not an e2e test file or a supported option; pass e2e test files and -t, --bail, --rerun-each, --only, --todo, --randomize, --seed, --parallel, --no-isolate, --reporter, or --reporter-outfile" >&2
  exit 2
}

root="$(pwd -P)/e2e/"
options=()
files=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    -t | --test-name-pattern | --rerun-each | --reporter | --reporter-outfile | --seed | --parallel)
      [ "$#" -ge 2 ] || refuse "$1"
      options+=("$1" "$2")
      shift 2
      ;;
    --test-name-pattern=* | --rerun-each=* | --reporter=* | --reporter-outfile=* | --seed=* | --parallel=* | --bail | --bail=* | --only | --todo | --randomize | --no-isolate)
      options+=("$1")
      shift
      ;;
    -*)
      refuse "$1"
      ;;
    *)
      if [[ "$1" != *.test.ts || ! -f "$1" ||
        "$(cd "$(dirname "$1")" && pwd -P)/" != "$root"* ]]; then
        refuse "$1"
      fi
      files+=("$1")
      shift
      ;;
  esac
done

if [ "${#files[@]}" -eq 0 ]; then
  files=(e2e/daemon-*.test.ts e2e/gateway-*.test.ts)
fi

exec "${command[@]}" ${options[@]+"${options[@]}"} "${files[@]}"
