#!/usr/bin/env bash
# Runs a command with HOME, XDG_RUNTIME_DIR, the XDG config, data, state,
# and cache homes, GROK_HOME, and CODEX_HOME set to a fresh temporary
# directory before the command's process starts, so
# Bun's os.homedir(), atc's config and state paths, its sockets, the agent
# homes, the real claude CLI's own files, and the git config a test's git
# reads all land there instead of the user's. It removes every variable atc sets for a session it
# hosts, so nothing reports to a live daemon from an enclosing session, and an inherited
# CLAUDE_CONFIG_DIR, so the Claude config folder resolves inside the home too.
# It keeps every other variable, ATC_BIN included. The directory is removed on exit.
# It also sets ATC_CLI_ENTRY and ATC_GATEWAY_ENTRY to the source entries of
# the atc and atc-gateway commands, so a shared test helper that runs either
# finds it without knowing where the app package sits.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# macOS sets TMPDIR with a trailing slash; trimming it keeps every exported
# path in the normalized form the preload compares against.
tmp="${TMPDIR:-/tmp}"
root=$(mktemp -d "${tmp%/}/atc-test-home-XXXXXX")
trap 'rm -rf "$root"' EXIT

mkdir -p "$root/home" "$root/runtime"
chmod 700 "$root/runtime"

export HOME="$root/home"
export XDG_RUNTIME_DIR="$root/runtime"
export XDG_CONFIG_HOME="$root/home/.config"
export XDG_DATA_HOME="$root/home/.local/share"
export XDG_STATE_HOME="$root/home/.local/state"
export XDG_CACHE_HOME="$root/home/.cache"
export GROK_HOME="$root/home/.grok"
export CODEX_HOME="$root/home/.codex"
export ATC_TEST_HOME="$root"
export ATC_CLI_ENTRY="$repo/packages/app/src/cli.ts"
export ATC_GATEWAY_ENTRY="$repo/packages/app/src/gateway.ts"
unset ATC_SESSION_ID ATC_SOCKET ATC_BRIDGE ATC_OUTBOX ATC_SESSION_RECORD CLAUDE_CONFIG_DIR

"$@"
