import { MAX_CHUNK, MAX_LINE } from '@atc/protocol/wire';
import { startStubPeerDaemon } from './start-stub-peer-daemon';

// A daemon that drops the connection on the first request after a
// handshake, and answers every later one with a spawned session.
export function startStubDroppingDaemon(socketPath: string) {
  const keys: unknown[] = [];
  const params: (Readonly<Record<string, unknown>> | undefined)[] = [];
  const principals: (string | undefined)[] = [];

  const daemon = startStubPeerDaemon(socketPath, {
    answer: (request) => {
      if (request.method === 'daemon.hello') {
        return {
          ok: {
            daemon: 'atc/dropping-build',
            limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
            lastUsedAgent: 'claude',
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
      principals.push(request.as);

      return keys.length === 1 ? 'close' : { ok: { session: { id: 's-1' } } };
    },
  });

  return {
    keys,
    params,
    principals,
    get reads() {
      return daemon.reads;
    },
    stop: daemon.stop,
  };
}
