#!/usr/bin/env bash
# Runs a command with HOME, XDG_RUNTIME_DIR, GROK_HOME, and CODEX_HOME set
# to a fresh temporary directory before the command's process starts, so
# Bun's os.homedir(), atc's config and state paths, its sockets, the agent
# homes, and the real claude CLI's own files all land there instead of the
# user's. It removes the enclosing atc session's ATC_SESSION_ID and
# ATC_SOCKET, so nothing reports to a live daemon, and keeps every other
# variable, ATC_BIN included. The directory is removed on exit.
set -euo pipefail

root=$(mktemp -d "${TMPDIR:-/tmp}/atc-test-home-XXXXXX")
trap 'rm -rf "$root"' EXIT

mkdir -p "$root/home" "$root/runtime"
chmod 700 "$root/runtime"

export HOME="$root/home"
export XDG_RUNTIME_DIR="$root/runtime"
export GROK_HOME="$root/home/.grok"
export CODEX_HOME="$root/home/.codex"
export ATC_TEST_HOME="$root"
unset ATC_SESSION_ID ATC_SOCKET

"$@"
