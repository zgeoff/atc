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

type LegacyRelease = 'pre-features' | 'pre-spawn-options';

/**
 * An older atc daemon listening on a unix socket and speaking the current
 * protocol version. `pre-features`, the default, is the release before
 * `daemon.hello` announced features: `message.get` ignores `waitMs` and
 * returns no turn, `events.read` ignores `session` and returns no `more`,
 * and `agents.list` is an unknown method. `pre-spawn-options` is the release
 * that announced every feature up to `message.wait`: its `agents.list`
 * answers with no `spawnOptions`, and the rest answers as `pre-features`
 * does. Every request it receives is recorded in `requests`. Stop it with
 * `stop`.
 */
export function startLegacyDaemon(socketPath: string, release: LegacyRelease = 'pre-features') {
  const answers = release === 'pre-features' ? LEGACY_ANSWERS : PRE_SPAWN_OPTIONS_ANSWERS;
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

const LEGACY_ANSWERS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'daemon.hello': {
    daemon: 'atc/legacy-build',
    limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
    lastUsedAgent: 'claude',
  },
  'daemon.ping': {},
  'session.list': { sessions: [] },
  'events.read': { events: [], cursor: 'eyJrIjoiZXYiLCJpIjowfQ' },
  'message.get': {
    message: 'm-legacy',
    session: 's-legacy',
    from: 'tester',
    text: 'hello',
    status: 'accepted',
    sentAt: 1_700_000_000_000,
  },
};

const PRE_SPAWN_OPTIONS_ANSWERS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  ...LEGACY_ANSWERS,
  'daemon.hello': {
    ...LEGACY_ANSWERS['daemon.hello'],
    features: ['agents.list', 'events.more', 'events.session', 'message.turn', 'message.wait'],
  },
  'agents.list': {
    daemon: { hostname: 'legacy-host', platform: 'linux', arch: 'x64', build: 'atc/legacy-build' },
    agents: [
      {
        id: 'claude',
        label: 'Claude',
        kind: 'claude',
        installed: true,
        capabilities: {
          spawn: true,
          readTranscript: true,
          message: true,
          attach: true,
          screen: true,
          input: true,
        },
        models: null,
      },
    ],
  },
};
