#!/usr/bin/env bash
# Points every reference at the callers that ride the daemon transport: the
# MCP caller and the gateway's caller for one daemon, under their new module
# and class names, and moves their package-map rows to the new paths. Run
# once from the repo root after the modules were renamed with git mv.
set -euo pipefail

mapfile -t files < <(git grep -l -E 'ReconnectingCaller|reconnecting-caller|DaemonCaller\b|federation/daemon-caller|\./daemon-caller' -- packages e2e scripts/package-map docs)

for file in "${files[@]}"; do
  sed -i -E \
    -e 's/\bReconnectingCaller\b/TransportCaller/g' \
    -e 's#mcp/reconnecting-caller#mcp/transport-caller#g' \
    -e 's#tools/reconnecting-caller#tools/transport-caller#g' \
    -e "s#'\\./reconnecting-caller'#'./transport-caller'#g" \
    -e 's/\bDaemonCaller\b/GatewayDaemonCaller/g' \
    -e 's#federation/daemon-caller#federation/gateway-daemon-caller#g' \
    -e 's#gateway/src/daemon-caller#gateway/src/gateway-daemon-caller#g' \
    -e "s#'\\./daemon-caller'#'./gateway-daemon-caller'#g" \
    "$file"
done

# The daemon transport's modules are new in the protocol package, so each
# takes a row that keeps it there in every wave.
for module in daemon-transport transport-machine index; do
  path="packages/protocol/src/wire/transport/${module}.ts"
  note=''

  if [[ "$module" == index ]]; then
    note='entry point'
  fi

  if ! grep -q "^${path}	" scripts/package-map/package-filemap.tsv; then
    printf '%s\tprotocol\twire\t%s\t%s\n' "$path" "$path" "$note" >> scripts/package-map/package-filemap.tsv
  fi

  if ! grep -q "^${path}	" scripts/package-map/package-stagemap.tsv; then
    {
      printf '%s\tprotocol' "$path"
      printf '\tprotocol%.0s' 1 2 3 4 5 6 7 8
      printf "\t${path}%.0s" 1 2 3 4 5 6 7 8
      printf '\n'
    } >> scripts/package-map/package-stagemap.tsv
  fi
done
