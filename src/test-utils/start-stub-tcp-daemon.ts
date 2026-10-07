import { z } from 'zod';
import { PROTOCOL_V } from '../protocol/protocol';

interface StubTCPDaemon {
  readonly port: number;

  // Every request method the stand-in received, in arrival order.
  readonly seen: string[];
  readonly [Symbol.dispose]: () => void;
}

// The two request fields the stand-in reads; every other field passes
// unread.
const REQUEST = z.object({ id: z.number(), m: z.string() });

/**
 * A stand-in for an atc daemon's TCP listener on a loopback port: it reads
 * newline-delimited protocol requests and answers each with an ok that holds
 * the request's method, recording every method in `seen`. It sends no
 * handshake of its own and checks no token. Disposal stops it.
 */
export function startStubTCPDaemon(): StubTCPDaemon {
  const seen: string[] = [];

  const server = Bun.listen<{ buffer: string }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: '' };
      },
      data(socket, buf) {
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
    [Symbol.dispose]: () => {
      server.stop(true);
    },
  };
}
