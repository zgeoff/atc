import type { SocketHandler } from 'bun';
import type { DaemonFeature } from '../protocol/daemon-features';
import {
  MAX_CHUNK,
  MAX_LINE,
  PROTOCOL_V,
  decodeMessage,
  encodeMessage,
} from '../protocol/protocol';
import { registerTestCleanup } from './register-test-cleanup';

interface ReceivedRequest {
  readonly m: string;
  readonly p: Readonly<Record<string, unknown>> | undefined;
}

// A TCP address to listen on in place of a unix socket; port 0 lets the
// kernel choose one.
interface StubLegacyDaemonTCPAddress {
  readonly hostname: string;
  readonly port: number;
}

interface StubLegacyDaemonOptions {
  readonly features?: readonly DaemonFeature[];

  // The protocol version the daemon speaks; a hello on any other version is
  // refused with `protocol_mismatch`, as a real daemon refuses it.
  readonly protocol?: number;

  readonly replies?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;

  // Who stops the daemon: the current test, once it finishes, or the
  // caller alone, for a process that runs it outside any test; the test
  // unless set.
  readonly owner?: 'test' | 'caller';
}

/**
 * An older atc daemon listening on a unix socket, or on the TCP address
 * given in its place, and speaking the current
 * protocol version, or the one `protocol` holds. Its `daemon.hello` announces `features` when the options
 * hold that list, and announces none without it, as a daemon from before
 * features did. It answers `daemon.hello`, `daemon.ping`, and each method in
 * `replies` with that method's reply, and refuses every other method with
 * `unknown_method`. Every request it receives is recorded in `requests`, and
 * `connections` counts the connections it accepted and those still open.
 * `port` holds the TCP port it bound, `null` on a unix socket. It stops
 * once the current test finishes, so it must run inside a test, unless the
 * options make the caller its owner; `stop` stops it sooner, and a second
 * stop does nothing.
 */
export function startStubLegacyDaemon(
  address: string | StubLegacyDaemonTCPAddress,
  options: StubLegacyDaemonOptions = {},
) {
  const answers: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    'daemon.hello': {
      daemon: 'atc/legacy-build',
      limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
      lastUsedAgent: 'claude',
      ...(options.features === undefined ? {} : { features: options.features }),
    },
    'daemon.ping': {},
    ...options.replies,
  };

  const protocol = options.protocol ?? PROTOCOL_V;
  const requests: ReceivedRequest[] = [];
  const connections = { accepted: 0, open: 0 };

  const handlers: SocketHandler<{ buffer: string }> = {
    open(socket) {
      socket.data = { buffer: '' };
      connections.accepted += 1;
      connections.open += 1;
    },
    close() {
      connections.open -= 1;
    },
    data(socket, chunk) {
      const lines = `${socket.data.buffer}${chunk.toString()}`.split('\n');

      socket.data.buffer = lines.pop() ?? '';

      for (const line of lines) {
        const decoded = decodeMessage(line);

        if (decoded.kind !== 'request') {
          continue;
        }

        const req = decoded.msg;

        requests.push({ m: req.m, p: req.p });

        if (req.m === 'daemon.hello' && req.v !== protocol) {
          const client = req.p?.['client'];

          socket.write(
            encodeMessage({
              v: protocol,
              id: req.id,
              err: {
                code: 'protocol_mismatch',
                msg: `${String(client)} speaks protocol v${req.v}, daemon atc/legacy-build speaks v${protocol}; restart the daemon so both run the same build`,
              },
            }),
          );

          continue;
        }

        const answer = answers[req.m];

        const reply =
          answer === undefined
            ? {
                v: protocol,
                id: req.id,
                err: { code: 'unknown_method' as const, msg: `unknown method '${req.m}'` },
              }
            : { v: protocol, id: req.id, ok: answer };

        socket.write(encodeMessage(reply));
      }
    },
  };

  const server = startListener(address, handlers);
  const stop = options.owner === 'caller' ? server.stop : registerTestCleanup(server.stop);

  return {
    requests,
    connections,
    port: server.port,
    stop,
  };
}

// Listens on the unix socket path, or on the TCP address in its place, and
// returns the port bound, `null` for a unix socket.
function startListener(
  address: string | StubLegacyDaemonTCPAddress,
  handlers: Readonly<SocketHandler<{ buffer: string }>>,
): { readonly port: number | null; readonly stop: () => void } {
  if (typeof address === 'string') {
    const unix = Bun.listen<{ buffer: string }>({ unix: address, socket: handlers });

    return {
      port: null,
      stop: () => {
        unix.stop(true);
      },
    };
  }

  const tcp = Bun.listen<{ buffer: string }>({
    hostname: address.hostname,
    port: address.port,
    socket: handlers,
  });

  return {
    port: tcp.port,
    stop: () => {
      tcp.stop(true);
    },
  };
}
