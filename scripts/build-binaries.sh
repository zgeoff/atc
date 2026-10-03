#!/usr/bin/env bash
# Compiles one static atc binary per supported platform into dist/, plus the
# atc-gateway binary for linux-x64, and writes their checksums. Every target
# cross-compiles from any host, so one runner builds the whole set. A target
# list on the command line narrows the set; the gateway builds when it
# includes linux-x64.
set -euo pipefail

cd "$(dirname "$0")/.."

targets=("$@")

if [ ${#targets[@]} -eq 0 ]; then
  targets=(darwin-arm64 darwin-x64 linux-x64 linux-arm64)
fi

rm -rf dist
mkdir -p dist

for target in "${targets[@]}"; do
  bun build --compile --target="bun-$target" src/cli.ts --outfile "dist/atc-$target"

  if [ "$target" = linux-x64 ]; then
    bun build --compile --target=bun-linux-x64 src/gateway.ts --outfile dist/atc-gateway-linux-x64
  fi
done

(cd dist && shasum -a 256 atc-* > SHA256SUMS)
