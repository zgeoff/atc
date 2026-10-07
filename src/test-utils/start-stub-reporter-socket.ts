import { waitFor } from './wait-for';

interface StubReporterSocket {
  // Every complete line received so far, newline removed, in arrival order.
  readonly lines: readonly string[];
  readonly waitForLine: () => Promise<string>;
  readonly [Symbol.dispose]: () => void;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * A stand-in for the daemon's reporter socket: listens on the unix socket
 * path and collects each newline-terminated line any connection writes,
 * buffering a partial line per connection, as the daemon reads the lines
 * hook and report commands send. It never writes back, and leaves each
 * connection for the sender to close. `waitForLine` resolves with the first
 * line once one has arrived, and rejects when none arrives within the
 * polling wait's default deadline. Disposal stops the listener; hold the
 * result with `using` or `await using`.
 */
export function startStubReporterSocket(path: string): StubReporterSocket {
  const lines: string[] = [];

  const server = Bun.listen<{ pending: string }>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { pending: '' };
      },
      data(socket, chunk) {
        const parts = `${socket.data.pending}${chunk.toString()}`.split('\n');

        socket.data.pending = parts.pop() ?? '';

        lines.push(...parts);
      },
      error() {},
    },
  });

  const stop = () => {
    server.stop(true);
  };

  return {
    lines,
    waitForLine: () =>
      waitFor(() => {
        const [first] = lines;

        if (first === undefined) {
          throw new Error(`no line has arrived at ${path}`);
        }

        return first;
      }),
    [Symbol.dispose]: stop,
    [Symbol.asyncDispose]: () => {
      stop();

      return Promise.resolve();
    },
  };
}
