#!/usr/bin/env bash
# Validates the atc-bridge mod and runs its tests against the installed
# Claude Code engine. The tests sit beside the hook module they test;
# bunfig.toml keeps bun test out of mods/, since only Claude Code's engine
# can run them.
set -euo pipefail

cd "$(dirname "$0")/.."

claude plugin validate --strict mods/atc-bridge
claude plugin test mods/atc-bridge
