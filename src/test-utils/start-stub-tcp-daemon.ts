import { z } from 'zod';
import { PROTOCOL_V } from '../protocol/protocol';

interface StubTCPDaemon {
  readonly port: number;

  // Every request method the stand-in received, in arrival order.
  readonly seen: string[];

  // How many reads the stand-in has taken from its connections, so a test
  // can wait until one piece of a split write has arrived before it sends
  // the next.
  readonly reads: number;
  readonly [Symbol.dispose]: () => void;
}

// The two request fields the stand-in reads; every other field passes
// unread.
const REQUEST = z.object({ id: z.number(), m: z.string() });

/**
 * A stand-in for an atc daemon's TCP listener on a loopback port: it reads
 * newline-delimited protocol requests and answers each with an ok that holds
 * the request's method, recording every method in `seen`. It sends no
 * handshake of its own and checks no token. `reads` counts the reads it has
 * taken from every connection. Disposal stops it.
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

  return {
    port: server.port,
    seen,
    get reads() {
      return reads;
    },
    [Symbol.dispose]: () => {
      server.stop(true);
    },
  };
}
