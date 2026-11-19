import { startStubPeerDaemon } from './start-stub-peer-daemon';

interface StubTCPDaemon {
  readonly port: number;

  readonly seen: string[];

  readonly reads: number;
  readonly stop: () => void;
}

export function startStubTCPDaemon(): StubTCPDaemon {
  const seen: string[] = [];

  const daemon = startStubPeerDaemon(
    { hostname: '127.0.0.1', port: 0 },
    {
      answer: (request) => {
        if (request.method === 'events.subscribe') {
          return 'silent';
        }

        seen.push(request.method);

        return { ok: { method: request.method } };
      },
    },
  );

  const port = daemon.port;

  if (port === null) {
    throw new Error('the TCP stand-in bound no port');
  }

  return {
    port,
    seen,
    get reads() {
      return daemon.reads;
    },
    stop: daemon.stop,
  };
}
