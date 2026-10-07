import type { DaemonFeature } from '../protocol/daemon-features';
import {
  MAX_CHUNK,
  MAX_LINE,
  PROTOCOL_V,
  decodeMessage,
  encodeMessage,
} from '../protocol/protocol';

interface DroppingDaemonOptions {
  // The features the first handshake announces.
  readonly features: readonly DaemonFeature[];

  // The features every later handshake announces, as a daemon restarted on
  // another build would; the first handshake's features when absent.
  readonly retryFeatures?: readonly DaemonFeature[];
}

/**
 * A daemon on a unix socket whose connection drops mid-request: it answers
 * each handshake as a daemon does, announcing the features the options give, ends the connection
 * that carries the first request of any other method without answering it,
 * and answers every later one with a session `s-1`. `keys` records the
 * idempotency key each of those requests carried, `undefined` for one that
 * carried none. `reads` counts the reads it has taken from every connection,
 * so a test can wait until one piece of a split write has arrived. Stop it
 * with `stop`, or hold it with `using`.
 */
export function startStubDroppingDaemon(socketPath: string, options: DroppingDaemonOptions) {
  const keys: unknown[] = [];
  let hellos = 0;
  let reads = 0;

  const server = Bun.listen<{ buffer: string }>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = { buffer: '' };
      },
      data(socket, buf) {
        reads += 1;

        const lines = `${socket.data.buffer}${buf.toString()}`.split('\n');

        socket.data.buffer = lines.pop() ?? '';

        for (const line of lines) {
          const decoded = decodeMessage(line);

          if (decoded.kind !== 'request') {
            continue;
          }

          if (decoded.msg.m === 'daemon.hello') {
            hellos += 1;

            const announced =
              hellos === 1 ? options.features : (options.retryFeatures ?? options.features);

            socket.write(
              encodeMessage({
                v: PROTOCOL_V,
                id: decoded.msg.id,
                ok: {
                  daemon: 'atc/dropping-build',
                  limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
                  lastUsedAgent: 'claude',
                  features: announced,
                },
              }),
            );

            continue;
          }

          keys.push(decoded.msg.p?.['idempotencyKey']);

          if (keys.length === 1) {
            socket.end();
            continue;
          }

          socket.write(
            encodeMessage({ v: PROTOCOL_V, id: decoded.msg.id, ok: { session: { id: 's-1' } } }),
          );
        }
      },
    },
  });

  return {
    keys,
    get reads() {
      return reads;
    },
    stop() {
      server.stop(true);
    },
    [Symbol.dispose]() {
      server.stop(true);
    },
  };
}
