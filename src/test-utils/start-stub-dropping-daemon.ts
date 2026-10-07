import type { DaemonFeature } from '../protocol/daemon-features';
import { PROTOCOL_V, decodeMessage, encodeMessage } from '../protocol/protocol';

interface DroppingDaemonOptions {
  // The features the first handshake announces.
  readonly features: readonly DaemonFeature[];

  // The features every later handshake announces, as a daemon restarted on
  // another build would; the first handshake's features when absent.
  readonly retryFeatures?: readonly DaemonFeature[];
}

/**
 * A daemon on a unix socket whose connection drops mid-request: it answers
 * each handshake with the features the options give, ends the connection
 * that carries the first request of any other method without answering it,
 * and answers every later one with a session `s-1`. `keys` records the
 * idempotency key each of those requests carried, `undefined` for one that
 * carried none. Stop it with `stop`, or hold it with `using`.
 */
export function startStubDroppingDaemon(socketPath: string, options: DroppingDaemonOptions) {
  const keys: unknown[] = [];
  let hellos = 0;

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, buf) {
        for (const line of buf.toString().split('\n')) {
          const decoded = decodeMessage(line);

          if (decoded.kind !== 'request') {
            continue;
          }

          if (decoded.msg.m === 'daemon.hello') {
            hellos += 1;

            const announced =
              hellos === 1 ? options.features : (options.retryFeatures ?? options.features);

            socket.write(
              encodeMessage({ v: PROTOCOL_V, id: decoded.msg.id, ok: { features: announced } }),
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
    stop() {
      server.stop(true);
    },
    [Symbol.dispose]() {
      server.stop(true);
    },
  };
}
