#!/usr/bin/env bash
# Packs @atcx/contract at the version its manifest holds and publishes it to npm with provenance:
#   publish-contract.sh [--dry-run]
# npm publishes it, because bun publish has no trusted publishing. --dry-run checks that Node imports the installed
# tarball and that TypeScript's nodenext resolution reads its declarations, then runs npm's publish
# as a dry run.
set -euo pipefail

usage='usage: publish-contract.sh [--dry-run]'
if ! args=$(getopt --name publish-contract.sh --options '' --longoptions dry-run -- "$@"); then
  echo "$usage" >&2
  exit 2
fi
eval set -- "$args"
dry_run=false
while [[ $1 != -- ]]; do
  case $1 in
    --dry-run) dry_run=true ;;
  esac
  shift
done
shift
if (($# > 0)); then
  echo "$usage" >&2
  exit 2
fi

root=$(cd "$(dirname "$0")/.." && pwd)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

tarball=$(bun "$root/scripts/pack-contract.ts" --out "$work")
packed=$(tar -xzOf "$tarball" package/package.json)
name=$(jq -r .name <<< "$packed")
version=$(jq -r .version <<< "$packed")

if jq -e '[.. | strings | select(startswith("catalog:") or startswith("workspace:"))] | length > 0' \
  <<< "$packed" > /dev/null; then
  echo "::error::the packed $name still names a catalog: or workspace: version"
  exit 1
fi
if tar -tzf "$tarball" | grep -E '\.ts$' | grep -vE '\.d\.ts$'; then
  echo "::error::the packed $name holds the TypeScript source above"
  exit 1
fi

if [[ $dry_run == true ]]; then
  consumer="$work/consumer"
  mkdir "$consumer"
  echo '{ "type": "module" }' > "$consumer/package.json"
  # oRPC's declarations import its optional peer @opentelemetry/api, which a consumer that checks
  # library declarations installs beside it
  npm install --prefix "$consumer" --no-audit --no-fund --silent "$tarball" \
    "typescript@$(jq -r .workspaces.catalog.typescript "$root/package.json")" \
    @opentelemetry/api@1.9.0
  (cd "$consumer" && node --input-type=module -e "
    const contract = await import('$name');
    const light = await import('$name/light');
    const check = contract.checkDaemon({ daemon: 'atc/$version', features: contract.DAEMON_FEATURES });
    if (check.verdict !== 'match') throw new Error('checkDaemon gave ' + check.verdict);
    if (typeof light.resolveAtcPaths !== 'function') throw new Error('$name/light exports no resolveAtcPaths');
    console.log('node imports $name, which exports ' + Object.keys(contract).length + ' names');
  ")

  cat > "$consumer/main.ts" << EOF
import { DAEMON_CONTRACT, HELLO_RESULT_SCHEMA, checkDaemon } from '$name';
import type { DaemonEvent, PublishedRecord, SessionID } from '$name';
import { SESSION_ENV_NAMES, resolveAtcPaths } from '$name/light';

export const verdict = checkDaemon(HELLO_RESULT_SCHEMA.parse({})).verdict;
export const hello = DAEMON_CONTRACT.daemon.hello;
export const socket: string = resolveAtcPaths({}).socketPath;
export const names = SESSION_ENV_NAMES.sessionID;
export type Read = [DaemonEvent, PublishedRecord, SessionID];
EOF
  echo '{ "compilerOptions": { "module": "nodenext", "strict": true, "noEmit": true, "skipLibCheck": false },
    "files": ["main.ts"] }' > "$consumer/tsconfig.json"
  (cd "$consumer" && ./node_modules/.bin/tsc -p tsconfig.json)
  echo "TypeScript's nodenext resolution typechecks a program that imports $name"

  npm publish "$tarball" --access public --dry-run
  exit 0
fi

bash "$root/scripts/publish-tarball.sh" "$tarball"
