import { expect, test } from 'bun:test';
import { checkDaemonSockets, isSocketOpener } from './check-daemon-sockets';

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

test.each([
  {
    title: 'connect imported from node:net',
    source: "import { connect } from 'node:net';",
    opens: true,
  },
  {
    title: 'connect imported beside a type from net',
    source: "import { connect, type Socket } from 'net';",
    opens: true,
  },
  { title: 'Bun.connect', source: 'await Bun.connect({ unix: path });', opens: true },
  {
    title: 'connect imported from the client',
    source: "import { connect } from '@atcx/client';",
    opens: false,
  },
])('#isSocketOpener reports $opens for $title', (row) => {
  expect(isSocketOpener(row.source)).toBe(row.opens);
});
