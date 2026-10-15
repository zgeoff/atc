#!/usr/bin/env bash
# Starts or stops one Codex App Server for the queue runs.
#   serve.sh start <native-codex-binary> <port> <codex-home>
#   serve.sh stop <port> [TERM|KILL]
# Pass the native binary, never the npm wrapper: a SIGKILL ends the wrapper
# and leaves its native child listening on the port.
set -u
here=$(cd "$(dirname "$0")" && pwd)
case "$1" in
  start)
    if pgrep -f "listen ws://127.0.0.1:$3\$" > /dev/null; then
      echo "port $3 busy"
      exit 1
    fi
    CODEX_HOME="$4" nohup "$2" app-server --listen "ws://127.0.0.1:$3" >> "$here/server-$3.log" 2>&1 &
    echo $! > "$here/server-$3.pid"
    for _ in $(seq 1 50); do
      curl -s -o /dev/null "http://127.0.0.1:$3/" && break
      sleep 0.2
    done
    echo "started $("$2" --version) pid $(cat "$here/server-$3.pid")"
    ;;
  stop)
    pid=$(cat "$here/server-$2.pid")
    kill -"${3:-TERM}" "$pid"
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2> /dev/null || break
      sleep 0.2
    done
    if pgrep -f "listen ws://127.0.0.1:$2\$" > /dev/null; then
      echo "a server still listens on $2"
      exit 1
    fi
    echo "stopped $pid with ${3:-TERM}"
    ;;
esac
