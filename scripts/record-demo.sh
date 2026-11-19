#!/usr/bin/env bash
# Records docs/assets/demo.gif against two throwaway atc daemons: a local one
# and a second one, "cloud", that the local config reaches over a loopback
# listener. Each has its own home directory, config and state, so nothing
# from the recording machine's fleet reaches the GIF. Every agent is the
# stand-in in run-demo-agent.ts, so the recording spends no model usage.
# run-demo-recording.ts stages the sessions, runs vhs on the tape and drives each
# beat; the header of docs/assets/demo.tape says how each beat is gated.
# Needs vhs, ttyd, ffmpeg, jq and bun on PATH.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# vhs's browser and the daemons' sockets refuse a long path, which a long
# TMPDIR gives them.
export TMPDIR=/tmp
DEMO=$(mktemp -d "$TMPDIR/atc-demo.XXXXXX")

# A daemon started from inside an atc or Claude session would hand its
# markers to every session it spawns, and atc would reach that session's daemon.
for v in $(env | grep -oE '^(CLAUDE|ATC_)[A-Za-z0-9_]*'); do unset "$v"; done

LOCAL_PID=
CLOUD_PID=
DONE=

# Every session exits before its daemon does.
stop_daemon() {
  local home=$1 run=$2 pid=$3
  [ -n "$pid" ] || return 0
  HOME=$home XDG_RUNTIME_DIR=$run bun "$ROOT/scripts/run-demo-recording.ts" kill-all "$run/atc-daemon.sock" 2> /dev/null || true
  for _ in $(seq 1 100); do
    pgrep -P "$pid" > /dev/null || break
    sleep 0.1
  done
  pkill -TERM -P "$pid" 2> /dev/null || true
  kill "$pid" 2> /dev/null || true
  wait "$pid" 2> /dev/null || true
}

teardown() {
  [ -n "$DONE" ] && return
  DONE=1
  stop_daemon "$DEMO/home" "$DEMO/run" "$LOCAL_PID"
  stop_daemon "$DEMO/cloud" "$DEMO/cloud-run" "$CLOUD_PID"
  rm -rf "$DEMO"
}
trap teardown EXIT INT TERM

# Both daemons run on this machine, so every session works in one folder of
# the local home, as if each box had the repo checked out at the same path:
# the list shows it from that home, as ~/projects/shop.
mkdir -p "$DEMO/bin" "$DEMO/run" "$DEMO/cloud-run" "$DEMO/cloud/.config/atc" \
  "$DEMO/home/.config/atc" "$DEMO/home/projects/shop" "$DEMO/cues"
printf '#!/bin/sh\nexec bun "%s/packages/app/src/cli.ts" "$@"\n' "$ROOT" > "$DEMO/bin/atc"
printf '#!/bin/sh\nexec bun "%s/scripts/run-demo-agent.ts" "$@"\n' "$ROOT" > "$DEMO/bin/demo-agent"
chmod +x "$DEMO/bin/atc" "$DEMO/bin/demo-agent"
export PATH="$DEMO/bin:$PATH"
export DEMO_HOME="$DEMO/home"
# The drive script drops a file named for a session here to cue that
# session's stand-in; the stand-ins inherit it from their daemon.
export DEMO_CUES="$DEMO/cues"

wait_for_file() {
  for _ in $(seq 1 100); do
    [ -e "$1" ] && return 0
    sleep 0.1
  done
  echo "record-demo: $1 never appeared" >&2
  cat "$DEMO"/*.log >&2
  exit 1
}

AGENTS=$(jq -n --arg bin "$DEMO/bin/demo-agent" '{ claude: { bin: $bin } }')

# The cloud daemon admits the local client as the principal "laptop".
TOKEN_FILE="$DEMO/cloud.token"
(umask 077 && od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$TOKEN_FILE")
jq -n --argjson agents "$AGENTS" \
  '{ agents: $agents, principals: { laptop: { targets: ["local"] } } }' \
  > "$DEMO/cloud/.config/atc/config.json"
HOME="$DEMO/cloud" XDG_RUNTIME_DIR="$DEMO/cloud-run" \
  atc daemon --listen 127.0.0.1:0 --token-file "$TOKEN_FILE" > "$DEMO/cloud-daemon.log" 2>&1 &
CLOUD_PID=$!

CLOUD_STATE="$DEMO/cloud/.local/state/atc/daemon.json"
wait_for_file "$DEMO/cloud-run/atc-daemon.sock"
wait_for_file "$CLOUD_STATE"
CLOUD_PORT=$(jq -er '.listenPort' "$CLOUD_STATE")

jq -n --argjson agents "$AGENTS" --arg address "127.0.0.1:$CLOUD_PORT" --arg token "$TOKEN_FILE" \
  '{ leader: "ctrl-space", agents: $agents, daemons: { cloud: { address: $address, principal: "laptop", tokenFile: $token } } }' \
  > "$DEMO/home/.config/atc/config.json"

export HOME="$DEMO/home"
export XDG_RUNTIME_DIR="$DEMO/run"

atc daemon > "$DEMO/daemon.log" 2>&1 &
LOCAL_PID=$!
wait_for_file "$XDG_RUNTIME_DIR/atc-daemon.sock"

# vhs writes the GIF into its working folder, and logs a failed encode without
# failing, so the GIF replaces the committed one only once it decodes.
cd "$DEMO"
bun "$ROOT/scripts/run-demo-recording.ts" record "$DEMO/run/atc-daemon.sock" "$DEMO/cloud-run/atc-daemon.sock" \
  "$DEMO/home/projects/shop" "$DEMO/cues" "$ROOT/docs/assets/demo.tape"
FRAMES=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 demo.gif)
# ffprobe prints N/A for a GIF with a header and no frames.
if ! [[ "$FRAMES" =~ ^[0-9]+$ ]] || [ "$FRAMES" -lt 1 ]; then
  echo "record-demo: vhs wrote no GIF that decodes" >&2
  exit 1
fi
cp demo.gif "$ROOT/docs/assets/.demo.gif.new"
mv "$ROOT/docs/assets/.demo.gif.new" "$ROOT/docs/assets/demo.gif"
