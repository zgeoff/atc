// A daemon connection of atc's own opens through @atcx/client. This fails when a file outside the
// list below opens a socket, so a second client cannot appear beside it.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readSourceFiles } from './read-source-files';

const SOCKET_OPENERS: ReadonlyMap<string, string> = new Map([
  ['packages/client/src/connection/open-daemon-connection.ts', 'the client itself'],
  ['packages/app/src/events/run-events.ts', 'the events socket, which carries lines, not calls'],
  ['packages/reporters/src/send-report.ts', 'the reporter socket'],
  ['packages/protocol/src/session/open-bridge-socket.ts', 'the bridge socket of a session'],
  ['packages/execution/docker/src/engine/open-hijacked-stream.ts', 'the Docker engine'],
]);

const OPENS_SOCKET = /\bBun\.connect\(|\bconnectSocket\(|createConnection\(/u;

// A file that imports connect from node:net opens a socket under that name.
const IMPORTS_NET_CONNECT = /import\s*\{[^}]*\bconnect\b[^}]*\}\s*from\s*'(?:node:)?net'/u;

export function isSocketOpener(source: string): boolean {
  return OPENS_SOCKET.test(source) || IMPORTS_NET_CONNECT.test(source);
}

// The daemon's own folder holds the listening side, and a test helper may open a raw socket.
const IGNORED = /\.test\.ts$|\/test-utils\/|\/daemon\/src\//u;

export function checkDaemonSockets(openers: readonly string[]): string[] {
  const found = new Set(openers);

  return [
    ...openers
      .filter((file) => !SOCKET_OPENERS.has(file))
      .map(
        (file) =>
          `unlisted socket opener: ${file} opens a socket; open a daemon connection through @atcx/client`,
      ),
    ...[...SOCKET_OPENERS.keys()]
      .filter((file) => !found.has(file))
      .map((file) => `stale entry: ${file} opens no socket; remove it from SOCKET_OPENERS`),
  ];
}

function main(): void {
  const root = resolve(join(import.meta.dir, '..'));

  const openers = readSourceFiles(root, 'packages')
    .filter((file) => file.includes('/src/') && !IGNORED.test(file))
    .filter((file) => isSocketOpener(readFileSync(join(root, file), 'utf8')));

  const findings = checkDaemonSockets(openers);

  for (const finding of findings) {
    console.error(finding);
  }

  console.log(
    `check-daemon-sockets: ${openers.length} socket openers, ${findings.length} findings`,
  );

  if (findings.length > 0) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
