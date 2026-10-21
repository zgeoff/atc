import { MAX_CHUNK, MAX_LINE, PROTOCOL_V } from '@atc/protocol/wire';
import { startStubPeerDaemon } from './start-stub-peer-daemon';
import type { StubPeerAnswer, StubPeerRequest } from './start-stub-peer-daemon';

interface ReceivedRequest {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>> | undefined;
}

// A TCP address to listen on in place of a unix socket; port 0 lets the
// kernel choose one.
interface StubLegacyDaemonTCPAddress {
  readonly hostname: string;
  readonly port: number;
}

interface StubLegacyDaemonOptions {
  // The protocol version the daemon speaks; a hello on any other version is
  // refused with `protocol_mismatch`, as a real daemon refuses it.
  readonly protocol?: number;

  // Puts the protocol version in the refusal's data as well as its message,
  // as a daemon of this build does; a released daemon before it puts the
  // version only in the message. Off unless set.
  readonly refusalHoldsProtocol?: boolean;

  readonly replies?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;

  // Drops the connection when this request arrives, without a response.
  readonly closeOnRequest?: string;

  // Who stops the daemon: the current test, once it finishes, or the
  // caller alone, for a process that runs it outside any test; the test
  // unless set.
  readonly owner?: 'test' | 'caller';
}

// A daemon of another build, which answers each request from its table of
// replies.
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
      // The client opens its event stream once the handshake passes, which
      // a scripted daemon holds open and never sends to.
      if (request.method === 'events.subscribe') {
        return 'silent';
      }

      requests.push({ method: request.method, params: request.params });

      if (request.method === options.closeOnRequest) {
        return 'close';
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
