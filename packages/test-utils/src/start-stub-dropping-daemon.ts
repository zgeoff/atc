import type { DaemonFeature } from '@atc/protocol';
import { MAX_CHUNK, MAX_LINE } from '@atc/protocol/wire';
import { startStubPeerDaemon } from './start-stub-peer-daemon';

interface DroppingDaemonOptions {
  // The features the first handshake announces.
  readonly features: readonly DaemonFeature[];

  // The features every later handshake announces, as a daemon restarted on
  // another build would; the first handshake's features when absent.
  readonly retryFeatures?: readonly DaemonFeature[];
}

// A daemon that drops the connection on the first request after a
// handshake, and answers every later one with a spawned session.
export function startStubDroppingDaemon(socketPath: string, options: DroppingDaemonOptions) {
  const keys: unknown[] = [];
  const params: (Readonly<Record<string, unknown>> | undefined)[] = [];
  let hellos = 0;

  const daemon = startStubPeerDaemon(socketPath, {
    answer: (request) => {
      if (request.method === 'daemon.hello') {
        hellos += 1;

        const announced =
          hellos === 1 ? options.features : (options.retryFeatures ?? options.features);

        return {
          ok: {
            daemon: 'atc/dropping-build',
            limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
            lastUsedAgent: 'claude',
            features: announced,
          },
        };
      }

      // The client opens its event stream once the handshake passes, which
      // this daemon never sends to.
      if (request.method === 'events.subscribe') {
        return 'silent';
      }

      keys.push(request.params?.['idempotencyKey']);
      params.push(request.params);

      return keys.length === 1 ? 'close' : { ok: { session: { id: 's-1' } } };
    },
  });

  return {
    keys,
    params,
    get reads() {
      return daemon.reads;
    },
    stop: daemon.stop,
  };
}
