#!/usr/bin/env bash
# Runs a command with HOME, XDG_RUNTIME_DIR, the XDG config, data, state,
# and cache homes, GROK_HOME, and CODEX_HOME set to a fresh temporary
# directory before the command's process starts, so
# Bun's os.homedir(), atc's config and state paths, its sockets, the agent
# homes, the real claude CLI's own files, and the git config a test's git
# reads all land there instead of the user's. It removes the enclosing atc session's ATC_SESSION_ID and
# ATC_SOCKET, so nothing reports to a live daemon, and keeps every other
# variable, ATC_BIN included. The directory is removed on exit. It also lets
# atc's git fetch over http and from local paths, the transports the
# suite's fixture repositories use; a test of the default transports unsets
# ATC_GIT_ALLOW_PROTOCOL itself.
set -euo pipefail

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
export ATC_GIT_ALLOW_PROTOCOL="https:ssh:http:file"
unset ATC_SESSION_ID ATC_SOCKET

"$@"
