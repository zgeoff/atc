#!/usr/bin/env bash
# Runs a test gate (default: `bun run test`) inside a synthetic "live" home
# that holds canary copies of everything atc, the agent CLIs, and git keep
# there, with HOME, XDG_RUNTIME_DIR, the XDG config, data, state, and cache
# homes, GROK_HOME, CODEX_HOME, ATC_SESSION_ID, and ATC_SOCKET all pointing
# into it, the way a run inside an atc session sees them. It fails when the
# gate changes, removes, or reads a canary, or creates a file, directory, or
# socket under the synthetic home's atc, git config, codex, grok, or claude
# directories. Reads are caught through access times, so they are detected
# only on a filesystem that updates them.
#
# Linux with GNU coreutils only: the snapshot relies on GNU `stat -c`,
# `touch -d`, and `sha256sum`, and the script stops before running the gate
# anywhere else.
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo "test isolation: runs on Linux only, not $(uname -s)" >&2
  exit 2
fi

for tool in stat touch sha256sum; do
  if ! command -v "$tool" > /dev/null || ! "$tool" --version 2> /dev/null | grep -q GNU; then
    echo "test isolation: needs GNU coreutils: $tool is missing or not the GNU build" >&2
    exit 2
  fi
done

cd "$(dirname "$0")/.."

tmp="${TMPDIR:-/tmp}"
outer=$(mktemp -d "${tmp%/}/atc-canary-XXXXXX")
trap 'rm -rf "$outer"' EXIT

home="$outer/home"
run="$outer/run"
canaries=(
  "$home/.local/state/atc/hook-settings-zai.json"
  "$home/.local/state/atc/hook-settings-claude.json"
  "$home/.local/state/atc/atc-bridge/.claude-plugin/plugin.json"
  "$home/.local/state/atc/atc.db"
  "$home/.local/state/atc/status.json"
  "$home/.local/state/atc/mcp-auth.db"
  "$home/.config/atc/config.json"
  "$home/.config/git/config"
  "$home/.codex/session_index.jsonl"
  "$home/.codex/hooks.json"
  "$home/.grok/hooks/atc-reporter.json"
  "$home/.claude.json"
  "$home/.claude/settings.json"
  "$run/atc-daemon.pid"
)

for file in "${canaries[@]}"; do
  mkdir -p "$(dirname "$file")"
  printf 'canary %s\n' "$file" > "$file"
done

# The git canary is a valid config, so a git that reads it runs on and only
# its access time gives it away.
printf '[atc]\n\tcanary = host\n' > "$home/.config/git/config"

chmod 700 "$run"

# An access time older than the modification time is updated by the next
# read even on a relatime mount.
touch -m -d '2001-01-01' "${canaries[@]}"
touch -a -d '2000-01-01' "${canaries[@]}"

snapshot() {
  for file in "${canaries[@]}"; do
    if [[ -e "$file" ]]; then
      # The access time is taken before hashing, which reads the file, and
      # put back after it.
      accessed=$(stat -c '%X' "$file")
      printf '%s %s %s %s\n' "$file" "$(sha256sum < "$file" | cut -d' ' -f1)" \
        "$(stat -c '%Y' "$file")" "$accessed"
      touch -a -d '2000-01-01' "$file"
    else
      printf '%s missing\n' "$file"
    fi
  done

  find "$home/.local/state/atc" "$home/.config/atc" "$home/.config/git" "$home/.codex" "$home/.grok" \
    "$home/.claude" "$run" -mindepth 1 | sort
}

before=$(snapshot)

if [[ $# -eq 0 ]]; then
  set -- bun run test
fi

env -u ATC_TEST_HOME HOME="$home" XDG_RUNTIME_DIR="$run" XDG_CONFIG_HOME="$home/.config" \
  XDG_DATA_HOME="$home/.local/share" XDG_STATE_HOME="$home/.local/state" \
  XDG_CACHE_HOME="$home/.cache" GROK_HOME="$home/.grok" \
  CODEX_HOME="$home/.codex" ATC_SESSION_ID=s-canary ATC_SOCKET="$run/atc.sock" "$@"

after=$(snapshot)

if [[ "$before" != "$after" ]]; then
  echo 'test isolation: the gate reached the synthetic live home:' >&2
  diff <(echo "$before") <(echo "$after") >&2 || true
  exit 1
fi

echo "test isolation: ${#canaries[@]} canaries unchanged and unread after: $*"
