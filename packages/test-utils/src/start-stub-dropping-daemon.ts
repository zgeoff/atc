import type { DaemonFeature } from '@atc/protocol';
import { MAX_CHUNK, MAX_LINE, PROTOCOL_V, decodeMessage, encodeMessage } from '@atc/protocol/wire';
import { registerTestCleanup } from './register-test-cleanup';

interface DroppingDaemonOptions {
  // The features the first handshake announces.
  readonly features: readonly DaemonFeature[];

  // The features every later handshake announces, as a daemon restarted on
  // another build would; the first handshake's features when absent.
  readonly retryFeatures?: readonly DaemonFeature[];
}

export function startStubDroppingDaemon(socketPath: string, options: DroppingDaemonOptions) {
  const keys: unknown[] = [];
  const params: (Readonly<Record<string, unknown>> | undefined)[] = [];
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
          params.push(decoded.msg.p);

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

  const stop = registerTestCleanup(() => {
    server.stop(true);
  });

  return {
    keys,
    params,
    get reads() {
      return reads;
    },
    stop,
  };
}
