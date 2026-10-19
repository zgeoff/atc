import { isRecord } from '@atc/core';
import { LineDecoder, PRINCIPAL_HEADERS } from '@atc/protocol/wire';
import { ORPCError } from '@orpc/client';
import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';
import type { StandardRequest, StandardResponse } from '@orpc/standard-server';
import { ServerPeer } from '@orpc/standard-server-peer';
import type { SocketHandler } from 'bun';
import { registerTestCleanup } from './register-test-cleanup';

// One request a client sent, as the stand-in reads it.
export interface StubPeerRequest {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>> | undefined;

  // The principal the request acts as, from its headers.
  readonly as: string | undefined;
  readonly asName: string | undefined;
}

// What the stand-in sends for one request: an answer, a refusal, an end of
// the connection with no response, or no response at all.
export type StubPeerAnswer =
  | { readonly ok: Readonly<Record<string, unknown>> }
  | {
      readonly err: {
        readonly code: string;
        readonly msg: string;
        readonly data?: Readonly<Record<string, unknown>>;
      };
    }
  | 'close'
  | 'silent';

// A TCP address to listen on in place of a unix socket; port 0 lets the
// kernel choose one.
interface StubPeerDaemonTCPAddress {
  readonly hostname: string;
  readonly port: number;
}

interface StubPeerDaemonOptions {
  readonly answer: (request: StubPeerRequest) => StubPeerAnswer;

  // Who stops the daemon: the current test, once it finishes, or the
  // caller alone, for a process that runs it outside any test; the test
  // unless set.
  readonly owner?: 'test' | 'caller';
}

interface StubPeerConnection {
  readonly lines: LineDecoder;
  readonly peer: ServerPeer;
}

const SERIALIZER = new StandardRPCSerializer(new StandardRPCJsonSerializer());

// A daemon stand-in that speaks oRPC peer messages, one JSON message per
// line, and answers each request as the caller's answer function says.
export function startStubPeerDaemon(
  address: string | StubPeerDaemonTCPAddress,
  options: StubPeerDaemonOptions,
) {
  const connections = { accepted: 0, open: 0 };
  let reads = 0;

  const handlers: SocketHandler<StubPeerConnection> = {
    open(socket) {
      socket.data = {
        lines: new LineDecoder(),
        peer: new ServerPeer((message) => {
          socket.write(`${String(message)}\n`);
        }),
      };

      connections.accepted += 1;
      connections.open += 1;
    },
    close(socket) {
      connections.open -= 1;

      socket.data.peer.close();
    },
    data(socket, chunk) {
      reads += 1;

      for (const line of socket.data.lines.splitChunk(chunk)) {
        // A line the peer cannot decode ends the connection.
        void (async () => {
          try {
            await socket.data.peer.message(line, (request) => {
              const answer = options.answer(readStubPeerRequest(request));

              if (answer === 'close') {
                socket.end();
              }

              return buildStubPeerResponse(answer);
            });
          } catch {
            socket.end();
          }
        })();
      }
    },
    error() {},
  };

  const server = startListener(address, handlers);
  const stop = options.owner === 'caller' ? server.stop : registerTestCleanup(server.stop);

  return {
    connections,
    port: server.port,
    get reads() {
      return reads;
    },
    stop,
  };
}

function readStubPeerRequest(request: StandardRequest): StubPeerRequest {
  const params: unknown = SERIALIZER.deserialize(request.body);
  const as = request.headers[PRINCIPAL_HEADERS.as];
  const asName = request.headers[PRINCIPAL_HEADERS.asName];

  return {
    method: request.url.pathname.split('/').filter(Boolean).join('.'),
    params: isRecord(params) ? params : undefined,
    as: typeof as === 'string' ? as : undefined,
    asName: typeof asName === 'string' ? asName : undefined,
  };
}

// A request left without a response waits until the connection ends.
function buildStubPeerResponse(answer: StubPeerAnswer): Promise<StandardResponse> {
  if (answer === 'close' || answer === 'silent') {
    return Promise.withResolvers<StandardResponse>().promise;
  }

  if ('ok' in answer) {
    return Promise.resolve({ status: 200, headers: {}, body: SERIALIZER.serialize(answer.ok) });
  }

  const error = new ORPCError<string, unknown>(answer.err.code, {
    message: answer.err.msg,
    data: answer.err.data,
  });

  return Promise.resolve({
    status: error.status,
    headers: {},
    body: SERIALIZER.serialize(error.toJSON()),
  });
}

// Listens on the unix socket path, or on the TCP address in its place, and
// returns the port bound, `null` for a unix socket.
function startListener(
  address: string | StubPeerDaemonTCPAddress,
  handlers: Readonly<SocketHandler<StubPeerConnection>>,
): { readonly port: number | null; readonly stop: () => void } {
  if (typeof address === 'string') {
    const unix = Bun.listen<StubPeerConnection>({ unix: address, socket: handlers });

    return {
      port: null,
      stop: () => {
        unix.stop(true);
      },
    };
  }

  const tcp = Bun.listen<StubPeerConnection>({
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
