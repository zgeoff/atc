import { startStubPeerDaemon } from './start-stub-peer-daemon';

interface StubTCPDaemon {
  readonly port: number;

  // Every request method the stand-in received, in arrival order.
  readonly seen: string[];

  // How many reads the stand-in has taken from its connections, so a test
  // can wait until one piece of a split write has arrived before it sends
  // the next.
  readonly reads: number;
  readonly stop: () => void;
}

// A daemon on a TCP port that answers every request with its own method.
export function startStubTCPDaemon(): StubTCPDaemon {
  const seen: string[] = [];

  const daemon = startStubPeerDaemon(
    { hostname: '127.0.0.1', port: 0 },
    {
      answer: (request) => {
        // The client opens its event stream once the handshake passes,
        // which this daemon holds open and never sends to.
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
