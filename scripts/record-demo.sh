#!/usr/bin/env bash
# Records docs/assets/demo.gif against an isolated atc daemon: its own home
# directory, config, state, and a curated zoxide list, so nothing from the
# recording machine's fleet or directory history reaches the GIF. Needs vhs,
# ttyd, ffmpeg, zoxide, bun, and a logged-in `claude` on PATH.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEMO=$(mktemp -d "${TMPDIR:-/tmp}/atc-demo.XXXXXX")
REAL_HOME=$HOME

# A daemon started from inside a Claude session would hand its child markers
# to every session it spawns.
for v in $(env | grep -oE '^(CLAUDE|ATC_)[A-Za-z0-9_]*'); do unset "$v"; done

DAEMON_PID=
VHS_PID=
DONE=

# Every session exits before the daemon does, and a recording cut short by
# a signal takes its terminal server and browser down with it.
teardown() {
  [ -n "$DONE" ] && return
  DONE=1
  [ -n "$VHS_PID" ] && kill -- "-$VHS_PID" 2>/dev/null || true
  bun "$ROOT/scripts/stage-demo-sessions.ts" kill-all 2>/dev/null || true
  if [ -n "$DAEMON_PID" ]; then
    for _ in $(seq 1 100); do
      pgrep -P "$DAEMON_PID" > /dev/null || break
      sleep 0.1
    done
    pkill -TERM -P "$DAEMON_PID" 2>/dev/null || true
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$DEMO"
}
trap teardown EXIT INT TERM

# A home directory with just enough of the real one for claude to run in it.
# The repository is a clone of this checkout's main branch, so the sessions
# show ~/projects/atc rather than a path on the recording machine.
mkdir -p "$DEMO/home/projects" "$DEMO/home/.config/atc" "$DEMO/home/.local" "$DEMO/home/bin" "$DEMO/run"
git clone -q --shared -b main "$ROOT" "$DEMO/home/projects/atc"
(cd "$DEMO/home/projects/atc" && bun install --frozen-lockfile --silent)
[ -d "$REAL_HOME/projects/tools" ] && ln -s "$REAL_HOME/projects/tools" "$DEMO/home/projects/tools"
ln -s "$REAL_HOME/.local/share" "$DEMO/home/.local/share"
for f in .claude .gitconfig; do
  [ -e "$REAL_HOME/$f" ] && ln -s "$REAL_HOME/$f" "$DEMO/home/$f"
done

# A copy of the Claude config, with the clone marked trusted, keeps the
# demo's writes out of the real file and the trust dialog out of the GIF.
jq --arg root "$ROOT" --arg clone "$DEMO/home/projects/atc" \
  '.projects[$clone] = ((.projects[$root] // {}) + { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true })' \
  "$REAL_HOME/.claude.json" > "$DEMO/home/.claude.json"
printf '{ "leader": "ctrl-space" }\n' > "$DEMO/home/.config/atc/config.json"
printf '#!/bin/sh\nexec bun "%s/src/cli.ts" "$@"\n' "$ROOT" > "$DEMO/home/bin/atc"
chmod +x "$DEMO/home/bin/atc"

export HOME="$DEMO/home"
export XDG_RUNTIME_DIR="$DEMO/run"
export _ZO_DATA_DIR="$DEMO/zoxide"
export PATH="$DEMO/home/bin:$PATH"

# The directory picker reads this list; repeats raise a directory's rank.
for d in projects/atc projects/atc projects/atc projects projects/tools .claude/plugins .claude; do
  [ -d "$HOME/$d" ] && zoxide add "$HOME/$d"
done

atc daemon > "$DEMO/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 50); do
  [ -S "$XDG_RUNTIME_DIR/atc-daemon.sock" ] && break
  sleep 0.1
done

# Two sessions already at work when the recording opens the list. The tape
# filters the list by the first name, so the two stay in step.
stage() { bun "$ROOT/scripts/stage-demo-sessions.ts" spawn "$@"; }
stage "$HOME/projects/atc" dinner "give me a recipe for your best chowder"
stage "$HOME/projects/atc" miracles "magnets how do they work??"
sleep 6

cd "$ROOT"
setsid vhs docs/assets/demo.tape &
VHS_PID=$!
wait "$VHS_PID"
