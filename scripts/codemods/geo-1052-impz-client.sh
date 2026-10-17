#!/usr/bin/env bash
# Points every reference to impd's client at its published name,
# `@impz/client`, which replaces the deprecated `@zgeoff/imp-client`, and
# pins the catalog to the client version atc supports. Run once from the
# repo root, then run `bun install` and `bun run build:import-rules`.
set -euo pipefail

mapfile -t files < <(git grep -l -F '@zgeoff/imp-client' -- packages scripts bunfig.toml package.json ':!scripts/codemods')

for file in "${files[@]}"; do
  sed -i -e 's#@zgeoff/imp-client#@impz/client#g' "$file"
done

sed -i -E -e 's#"@impz/client": "[^"]+"#"@impz/client": "2.3.0"#' package.json

# The impd stand-in takes only codes impd's contract answers with, so the
# tests that make it fail use oRPC's INTERNAL_SERVER_ERROR and the
# contract's SERVICE_UNAVAILABLE in place of codes impd never sends.
mapfile -t tests < <(git grep -l -E "'(INTERNAL|UNAVAILABLE)'|\(UNAVAILABLE\)" -- 'e2e/spawn-imp*.test.ts' 'packages/execution/imp/src/**.test.ts')

for file in "${tests[@]}"; do
  sed -i -E \
    -e "s/'UNAVAILABLE'/'SERVICE_UNAVAILABLE'/g" \
    -e 's/\(UNAVAILABLE\)/(SERVICE_UNAVAILABLE)/g' \
    -e "s/'INTERNAL'/'INTERNAL_SERVER_ERROR'/g" \
    "$file"
done
