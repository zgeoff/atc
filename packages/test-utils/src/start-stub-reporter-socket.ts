import { registerTestCleanup } from './register-test-cleanup';
import { waitFor } from './wait-for';

interface StubReporterSocket {
  // Every complete line received so far, newline removed, in arrival order.
  readonly lines: readonly string[];

  // How many reads the stand-in has taken from its connections, so a test
  // can wait until one piece of a split write has arrived.
  readonly reads: number;
  readonly waitForLine: (timeoutMs?: number) => Promise<string>;
  readonly stop: () => void;
}

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
    stop,
  };
}
