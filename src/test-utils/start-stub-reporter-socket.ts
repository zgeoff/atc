import { registerTestCleanup } from './register-test-cleanup';
import { waitFor } from './wait-for';

interface StubReporterSocket {
  // Every complete line received so far, newline removed, in arrival order.
  readonly lines: readonly string[];

  // How many reads the stand-in has taken from its connections, so a test
  // can wait until one piece of a split write has arrived.
  readonly reads: number;
  readonly waitForLine: (timeoutMs?: number) => Promise<string>;
  readonly [Symbol.dispose]: () => void;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * A stand-in for the daemon's reporter socket: listens on the unix socket
 * path and collects each newline-terminated line any connection writes,
 * buffering a partial line per connection, as the daemon reads the lines
 * hook and report commands send. It never writes back, and leaves each
 * connection for the sender to close. `waitForLine` resolves with the first
 * line once one has arrived, and rejects naming the socket when none arrives
 * within `timeoutMs`, 5 seconds by default. The listener stops once the
 * current test finishes, so it must run inside a test; disposal stops it
 * sooner, and a second stop does nothing.
 */
export function startStubReporterSocket(path: string): StubReporterSocket {
  const lines: string[] = [];
  let reads = 0;

  const server = Bun.listen<{ pending: string }>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { pending: '' };
      },
      data(socket, chunk) {
        reads += 1;

        const parts = `${socket.data.pending}${chunk.toString()}`.split('\n');

        socket.data.pending = parts.pop() ?? '';

        lines.push(...parts);
      },
      error() {},
    },
  });

  const stop = registerTestCleanup(() => {
    server.stop(true);
  });

  return {
    lines,
    get reads() {
      return reads;
    },
    waitForLine: (timeoutMs = 5000) =>
      waitFor(
        () => {
          const [first] = lines;

          if (first === undefined) {
            throw new Error(`no line has arrived at ${path}`);
          }

          return first;
        },
        { timeoutMs },
      ),
    [Symbol.dispose]: stop,
    [Symbol.asyncDispose]: () => {
      stop();

      return Promise.resolve();
    },
  };
}
