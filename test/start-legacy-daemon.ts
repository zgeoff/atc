import type { DaemonFeature } from '../src/protocol/daemon-features';
import {
  MAX_CHUNK,
  MAX_LINE,
  PROTOCOL_V,
  decodeMessage,
  encodeMessage,
} from '../src/protocol/protocol';

interface ReceivedRequest {
  readonly m: string;
  readonly p: Readonly<Record<string, unknown>> | undefined;
}

interface LegacyDaemonOptions {
  readonly features?: readonly DaemonFeature[];
  readonly replies?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * An older atc daemon listening on a unix socket and speaking the current
 * protocol version. Its `daemon.hello` announces `features` when the options
 * hold that list, and announces none without it, as a daemon from before
 * features did. It answers `daemon.hello`, `daemon.ping`, and each method in
 * `replies` with that method's reply, and refuses every other method with
 * `unknown_method`. Every request it receives is recorded in `requests`. Stop
 * it with `stop`.
 */
export function startLegacyDaemon(socketPath: string, options: LegacyDaemonOptions = {}) {
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

  const requests: ReceivedRequest[] = [];

  const server = Bun.listen<{ buffer: string }>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = { buffer: '' };
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

          const answer = answers[req.m];

          const reply =
            answer === undefined
              ? {
                  v: PROTOCOL_V,
                  id: req.id,
                  err: { code: 'unknown_method' as const, msg: `unknown method '${req.m}'` },
                }
              : { v: PROTOCOL_V, id: req.id, ok: answer };

          socket.write(encodeMessage(reply));
        }
      },
    },
  });

  return {
    requests,
    stop() {
      server.stop(true);
    },
  };
}
