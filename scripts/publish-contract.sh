#!/usr/bin/env bash
# Packs @atcx/contract and @atcx/client at the version their manifests hold and publishes them to npm
# with provenance, the contract first, because the client depends on it:
#   publish-contract.sh [--dry-run]
# npm publishes them, because bun publish has no trusted publishing. Each package gets the same
# checks before anything is published: no catalog: or workspace: version, no TypeScript source, and
# no import outside its dependencies. --dry-run also installs both tarballs into a Node project,
# checks that Node imports each, that TypeScript's nodenext resolution reads each one's
# declarations, and that the client connects, sends and reads an event from a stub daemon on Node
# and on Bun. It then runs npm's publish as a dry run for a version npm does not hold yet.
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
stub_pid=
cleanup() {
  if [[ -n $stub_pid ]]; then
    kill "$stub_pid" 2> /dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# the contract first: the client's range needs the version it publishes
packages=(contract client)
declare -A tarballs names

for package in "${packages[@]}"; do
  mkdir "$work/$package"
  tarball=$(bun "$root/scripts/pack-contract.ts" --out "$work/$package" --package "$package")
  packed=$(tar -xzOf "$tarball" package/package.json)
  name=$(jq -r .name <<< "$packed")
  version=$(jq -r .version <<< "$packed")
  tarballs[$package]=$tarball
  names[$package]=$name

  if jq -e '[.. | strings | select(startswith("catalog:") or startswith("workspace:"))] | length > 0' \
    <<< "$packed" > /dev/null; then
    echo "::error::the packed $name still names a catalog: or workspace: version"
    exit 1
  fi
  if tar -tzf "$tarball" | grep -E '\.ts$' | grep -vE '\.d\.ts$'; then
    echo "::error::the packed $name holds the TypeScript source above"
    exit 1
  fi

  mkdir "$work/$package/extracted"
  tar -xzf "$tarball" -C "$work/$package/extracted"
  node "$root/scripts/check-tarball-imports.mjs" "$work/$package/extracted/package"
done

if [[ $dry_run == true ]]; then
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  if ((node_major < 22)); then
    echo "::error::the dry run needs Node 22 or later, and node is $(node --version)"
    exit 1
  fi

  contract=${names[contract]}
  client=${names[client]}
  version=$(tar -xzOf "${tarballs[contract]}" package/package.json | jq -r .version)

  consumer="$work/consumer"
  mkdir "$consumer"
  echo '{ "type": "module" }' > "$consumer/package.json"
  # oRPC's declarations import its optional peer @opentelemetry/api, and the client's import
  # node:net, so a consumer that checks library declarations installs both packages' types
  npm install --prefix "$consumer" --no-audit --no-fund --silent \
    "${tarballs[contract]}" "${tarballs[client]}" \
    "typescript@$(jq -r .workspaces.catalog.typescript "$root/package.json")" \
    @opentelemetry/api@1.9.0 @types/node@22
  (cd "$consumer" && node --input-type=module -e "
    const contract = await import('$contract');
    const light = await import('$contract/light');
    const check = contract.checkDaemon({ daemon: 'atc/$version', features: contract.DAEMON_FEATURES });
    if (check.verdict !== 'match') throw new Error('checkDaemon gave ' + check.verdict);
    if (typeof light.resolveAtcPaths !== 'function') throw new Error('$contract/light exports no resolveAtcPaths');
    console.log('node imports $contract, which exports ' + Object.keys(contract).length + ' names');
    const client = await import('$client');
    const connection = await import('$client/connection');
    if (typeof client.connect !== 'function') throw new Error('$client exports no connect');
    if (typeof connection.openDaemonConnection !== 'function') throw new Error('$client/connection exports no openDaemonConnection');
    if (new client.AtcError('internal', 'x').code !== 'internal') throw new Error('$client exports no AtcError');
    console.log('node imports $client, which exports ' + Object.keys(client).length + ' names');
  ")

  cat > "$consumer/main.ts" << EOF
import { DAEMON_CONTRACT, HELLO_RESULT_SCHEMA, checkDaemon } from '$contract';
import type { DaemonEvent, PublishedRecord, SessionID } from '$contract';
import { SESSION_ENV_NAMES, resolveAtcPaths } from '$contract/light';
import { AtcError, connect, readDaemonSocketPaths } from '$client';
import type { AtcClient, ConnectOptions } from '$client';
import { openDaemonConnection } from '$client/connection';
import type { CallContext, DaemonConnection } from '$client/connection';

export const verdict = checkDaemon(HELLO_RESULT_SCHEMA.parse({})).verdict;
export const hello = DAEMON_CONTRACT.daemon.hello;
export const socket: string = resolveAtcPaths({}).socketPath;
export const names = SESSION_ENV_NAMES.sessionID;
export type Read = [DaemonEvent, PublishedRecord, SessionID];

export async function watch(options: ConnectOptions): Promise<string[]> {
  await using atc: AtcClient = await connect(options);
  const { sessions } = await atc.session.list({});
  const seen: string[] = sessions.map((session) => session.id);
  for await (const event of atc.events()) {
    seen.push(event.ev);
  }
  return seen;
}

export async function open(path: string, context: CallContext): Promise<unknown> {
  const connection: DaemonConnection = await openDaemonConnection({ path }, { client: 'x' });
  return connection.request('session.list', {}, context);
}

export const failure = (error: unknown): string => (error instanceof AtcError ? error.code : '');
export const paths = readDaemonSocketPaths;
EOF
  echo '{ "compilerOptions": { "module": "nodenext", "target": "esnext", "strict": true, "noEmit": true, "skipLibCheck": false, "types": ["node"] },
    "files": ["main.ts"] }' > "$consumer/tsconfig.json"
  (cd "$consumer" && ./node_modules/.bin/tsc -p tsconfig.json)
  echo "TypeScript's nodenext resolution typechecks a program that imports $contract and $client"

  # a stub daemon in the repository answers the packed client, so the run needs nothing but the
  # tarball's own dependencies on the consumer's side
  cp "$root/scripts/smoke-client.mjs" "$consumer/smoke-client.mjs"
  mkfifo "$work/stub-output"
  bun "$root/scripts/serve-stub-daemon.ts" > "$work/stub-output" &
  stub_pid=$!
  read -r socket_path < "$work/stub-output"
  (cd "$consumer" && node smoke-client.mjs "$socket_path")
  (cd "$consumer" && bun smoke-client.mjs "$socket_path")

  for package in "${packages[@]}"; do
    bash "$root/scripts/publish-tarball.sh" --dry-run "${tarballs[$package]}"
  done
  exit 0
fi

for package in "${packages[@]}"; do
  bash "$root/scripts/publish-tarball.sh" "${tarballs[$package]}"
done
