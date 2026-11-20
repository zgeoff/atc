import { buildStubHelloAnswer } from '@atc/protocol/test-utils/build-stub-hello-answer';
import { startStubPeerDaemon } from '@atc/protocol/test-utils/start-stub-peer-daemon';

export function startStubRestoreDaemon(socketPath: string) {
  const lists: Readonly<Record<string, unknown>>[] = [];
  const methods: string[] = [];

  const unknown = new Set<string>();

  const daemon = startStubPeerDaemon(socketPath, {
    answer: (request) => {
      if (request.method === 'events.subscribe') {
        return 'silent';
      }

      if (request.method === 'daemon.hello') {
        return { ok: buildStubHelloAnswer() };
      }

      methods.push(request.method);

      if (unknown.has(request.method)) {
        return {
          err: { code: 'unknown_method', message: `unknown method '${request.method}'` },
        };
      }

      const ok = request.method === 'fleet.restore' ? {} : lists.shift();

      return ok === undefined ? 'silent' : { ok };
    },
  });

  return {
    lists,
    methods,
    unknown,
    stop: daemon.stop,
  };
}
