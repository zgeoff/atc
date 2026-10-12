import { z } from 'zod';
import { PROTOCOL_V } from '../protocol/protocol';
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

/**
 * A stand-in for an atc daemon's TCP listener on a loopback port: it reads
 * newline-delimited protocol requests and answers each with an ok that holds
 * the request's method, recording every method in `seen`. It sends no
 * handshake of its own and checks no token. `reads` counts the reads it has
 * taken from every connection. It stops once the current test finishes, so
 * it must run inside a test; `stop` stops it sooner, and a second stop
 * does nothing.
 */
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
