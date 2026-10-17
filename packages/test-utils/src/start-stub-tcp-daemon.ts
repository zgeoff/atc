import { PROTOCOL_V } from '@atc/protocol/wire';
import { z } from 'zod';
import { registerTestCleanup } from './register-test-cleanup';

interface StubTCPDaemon {
  readonly port: number;

  // Every request method the stand-in received, in arrival order.
  readonly seen: string[];

  // How many reads the stand-in has taken from its connections, so a test
  // can wait until one piece of a split write has arrived before it sends
  // the next.
  readonly reads: number;
  readonly stop: () => void;
}

// The two request fields the stand-in reads; every other field passes
// unread.
const REQUEST = z.object({ id: z.number(), m: z.string() });

export function startStubTCPDaemon(): StubTCPDaemon {
  const seen: string[] = [];
  let reads = 0;

  const server = Bun.listen<{ buffer: string }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: '' };
      },
      data(socket, buf) {
        reads += 1;

        const lines = `${socket.data.buffer}${buf.toString()}`.split('\n');

        socket.data.buffer = lines.pop() ?? '';

        for (const line of lines.filter((part) => part !== '')) {
          const request = REQUEST.parse(JSON.parse(line));

          seen.push(request.m);

          socket.write(
            `${JSON.stringify({ v: PROTOCOL_V, id: request.id, ok: { m: request.m } })}\n`,
          );
        }
      },
      error() {},
    },
  });

  const stop = registerTestCleanup(() => {
    server.stop(true);
  });

  return {
    port: server.port,
    seen,
    get reads() {
      return reads;
    },
    stop,
  };
}
