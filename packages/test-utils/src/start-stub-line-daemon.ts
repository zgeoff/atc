import { registerTestCleanup } from './register-test-cleanup';

interface StubLineDaemonOptions {
  // Who stops the daemon: the current test, once it finishes, or the
  // caller alone, for a process that runs it outside any test; the test
  // unless set.
  readonly owner?: 'test' | 'caller';
}

// A daemon of a release that speaks the line protocol, version 4. A line
// without a version is malformed to it, so it answers each connection's
// first line with that error, as id 0, and ends the connection.
export function startStubLineDaemon(socketPath: string, options: StubLineDaemonOptions = {}) {
  const lines: string[] = [];

  const server = Bun.listen<{ answered: boolean }>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = { answered: false };
      },
      data(socket, buf) {
        lines.push(...new TextDecoder().decode(buf).split('\n').filter(Boolean));

        if (socket.data.answered) {
          return;
        }

        socket.data.answered = true;

        socket.write(
          `${JSON.stringify({ v: 4, id: 0, err: { code: 'bad_args', msg: 'malformed line: missing v' } })}\n`,
        );

        socket.end();
      },
    },
  });

  const stop =
    options.owner === 'caller'
      ? () => server.stop(true)
      : registerTestCleanup(() => server.stop(true));

  return { lines, stop };
}
