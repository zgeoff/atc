import { isRecord } from '@atc/core';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { ORPCError } from '@orpc/client';
import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';
import type { StandardRequest, StandardResponse } from '@orpc/standard-server';
import { ServerPeer } from '@orpc/standard-server-peer';
import type { SocketHandler } from 'bun';
import { PRINCIPAL_HEADERS, createLineDecoder } from '../wire/index';
import type { LineDecoder } from '../wire/index';

export interface StubPeerRequest {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>> | undefined;

  readonly as: string | undefined;
  readonly asName: string | undefined;
}

export type StubPeerAnswer =
  | { readonly ok: Readonly<Record<string, unknown>> }
  | {
      readonly err: {
        readonly code: string;
        readonly message: string;
        readonly data?: Readonly<Record<string, unknown>>;
      };
    }
  | 'close'
  | 'silent';

interface StubPeerDaemonTCPAddress {
  readonly hostname: string;
  readonly port: number;
}

interface StubPeerDaemonOptions {
  readonly answer: (request: StubPeerRequest) => StubPeerAnswer;

  readonly owner?: 'test' | 'caller';
}

interface StubPeerConnection {
  readonly lines: LineDecoder;
  readonly peer: ServerPeer;
}

export function startStubPeerDaemon(
  address: string | StubPeerDaemonTCPAddress,
  options: StubPeerDaemonOptions,
) {
  const connections = { accepted: 0, open: 0 };
  let reads = 0;

  const handlers: SocketHandler<StubPeerConnection> = {
    open(socket) {
      socket.data = {
        lines: createLineDecoder(),

        // oRPC peers encode every message as a JSON string.
        peer: new ServerPeer((message) => {
          if (typeof message === 'string') {
            socket.write(`${message}\n`);
          }
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

const SERIALIZER = new StandardRPCSerializer(new StandardRPCJsonSerializer());

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

function buildStubPeerResponse(answer: StubPeerAnswer): Promise<StandardResponse> {
  if (answer === 'close' || answer === 'silent') {
    return Promise.withResolvers<StandardResponse>().promise;
  }

  if ('ok' in answer) {
    return Promise.resolve({ status: 200, headers: {}, body: SERIALIZER.serialize(answer.ok) });
  }

  const error = new ORPCError<string, unknown>(answer.err.code, {
    message: answer.err.message,
    data: answer.err.data,
  });

  return Promise.resolve({
    status: error.status,
    headers: {},
    body: SERIALIZER.serialize(error.toJSON()),
  });
}

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
