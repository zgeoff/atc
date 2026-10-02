#!/usr/bin/env bash
# Validates the atc-bridge mod and runs its tests against the installed
# Claude Code engine. The mod's tests live in a dot-directory because bun's
# runner skips dot-directories and CI's bun has no option to ignore a path,
# while `claude plugin test` skips them too, so they are staged into a
# visible tests/ folder of a temporary copy first.
set -euo pipefail

cd "$(dirname "$0")/.."

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

cp -R mods/atc-bridge/. "$stage/"
rm -rf "$stage/.tests"
mkdir -p "$stage/tests"
cp mods/atc-bridge/.tests/*.test.ts "$stage/tests/"

claude plugin validate --strict "$stage"
claude plugin test "$stage"
