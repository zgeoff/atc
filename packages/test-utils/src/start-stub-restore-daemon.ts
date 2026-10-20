import { startStubPeerDaemon } from './start-stub-peer-daemon';

export function startStubRestoreDaemon(socketPath: string) {
  const lists: Readonly<Record<string, unknown>>[] = [];
  const methods: string[] = [];

  const unknown = new Set<string>();

  const daemon = startStubPeerDaemon(socketPath, {
    answer: (request) => {
      // The client opens its event stream once the handshake passes, which
      // this daemon holds open and never sends to.
      if (request.method === 'events.subscribe') {
        return 'silent';
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
