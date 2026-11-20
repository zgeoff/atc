import { expect, test } from 'bun:test';
import { checkDaemonSockets } from './check-daemon-sockets';

test('it finds no problem when the files that open a socket are the listed ones', () => {
  const findings = checkDaemonSockets([
    'packages/client/src/connection/open-daemon-connection.ts',
    'packages/app/src/events/run-events.ts',
    'packages/reporters/src/send-report.ts',
    'packages/protocol/src/session/open-bridge-socket.ts',
    'packages/execution/docker/src/engine/open-hijacked-stream.ts',
  ]);

  expect(findings).toStrictEqual([]);
});

test('it names a file that opens a socket without being listed', () => {
  const findings = checkDaemonSockets([
    'packages/client/src/connection/open-daemon-connection.ts',
    'packages/app/src/events/run-events.ts',
    'packages/reporters/src/send-report.ts',
    'packages/protocol/src/session/open-bridge-socket.ts',
    'packages/execution/docker/src/engine/open-hijacked-stream.ts',
    'packages/tui/src/daemon-link/open-own-socket.ts',
  ]);

  expect(findings).toStrictEqual([
    'unlisted socket opener: packages/tui/src/daemon-link/open-own-socket.ts opens a socket; open a daemon connection through @atcx/client',
  ]);
});

test('it names a listed file that no longer opens a socket', () => {
  const findings = checkDaemonSockets(['packages/client/src/connection/open-daemon-connection.ts']);

  expect(findings).toHaveLength(4);
});
