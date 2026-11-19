import { MAX_CHUNK, MAX_LINE, PROTOCOL_V } from '../wire/index';
import { startStubPeerDaemon } from './start-stub-peer-daemon';
import type { StubPeerAnswer, StubPeerRequest } from './start-stub-peer-daemon';

interface ReceivedRequest {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>> | undefined;
}

interface StubLegacyDaemonTCPAddress {
  readonly hostname: string;
  readonly port: number;
}

interface StubLegacyDaemonOptions {
  readonly protocol?: number;

  // Released daemons can omit the protocol version from their refusal's data.
  readonly refusalHoldsProtocol?: boolean;

  readonly replies?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;

  readonly refusals?: Readonly<Record<string, { readonly code: string; readonly message: string }>>;

  readonly closeOnRequest?: string;

  readonly owner?: 'test' | 'caller';
}

export function startStubLegacyDaemon(
  address: string | StubLegacyDaemonTCPAddress,
  options: StubLegacyDaemonOptions = {},
) {
  const answers: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    'daemon.hello': {
      daemon: 'atc/legacy-build',
      daemonID: 'd-legacy',
      limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
      lastUsedAgent: 'claude',
    },
    'daemon.ping': {},
    ...options.replies,
  };

  const protocol = options.protocol ?? PROTOCOL_V;
  const requests: ReceivedRequest[] = [];

  const daemon = startStubPeerDaemon(address, {
    owner: options.owner ?? 'test',
    answer: (request) => {
      if (request.method === 'events.subscribe') {
        return 'silent';
      }

      requests.push({ method: request.method, params: request.params });

      if (request.method === options.closeOnRequest) {
        return 'close';
      }

      const refusal = options.refusals?.[request.method];

      if (refusal !== undefined) {
        return { err: refusal };
      }

      return pickLegacyAnswer(request, answers, protocol, options.refusalHoldsProtocol ?? false);
    },
  });

  return {
    requests,
    connections: daemon.connections,
    port: daemon.port,
    stop: daemon.stop,
  };
}

function pickLegacyAnswer(
  request: StubPeerRequest,
  answers: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  protocol: number,
  refusalHoldsProtocol: boolean,
): StubPeerAnswer {
  const asked = request.params?.['protocol'];

  if (request.method === 'daemon.hello' && asked !== protocol) {
    const client = request.params?.['client'];

    return {
      err: {
        code: 'protocol_mismatch',
        message: `${String(client)} speaks protocol v${String(asked)}, daemon atc/legacy-build speaks v${protocol}; restart the daemon so both run the same build`,
        ...(refusalHoldsProtocol ? { data: { daemonProtocol: protocol } } : {}),
      },
    };
  }

  const answer = answers[request.method];

  return answer === undefined
    ? { err: { code: 'unknown_method', message: `unknown method '${request.method}'` } }
    : { ok: answer };
}
