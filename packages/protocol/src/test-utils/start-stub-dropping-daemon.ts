import { MAX_CHUNK, MAX_LINE } from '../wire/index';
import { buildStubHelloAnswer } from './build-stub-hello-answer';
import { startStubPeerDaemon } from './start-stub-peer-daemon';

export function startStubDroppingDaemon(socketPath: string) {
  const keys: unknown[] = [];
  const params: (Readonly<Record<string, unknown>> | undefined)[] = [];
  const principals: (string | undefined)[] = [];

  const daemon = startStubPeerDaemon(socketPath, {
    answer: (request) => {
      if (request.method === 'daemon.hello') {
        return {
          ok: {
            ...buildStubHelloAnswer(),
            daemon: 'atc/dropping-build',
            limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
          },
        };
      }

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
