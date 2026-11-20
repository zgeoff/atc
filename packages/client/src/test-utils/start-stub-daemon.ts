import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORPCError } from '@orpc/client';
import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';
import type { StandardRequest, StandardResponse } from '@orpc/standard-server';
import { ServerPeer } from '@orpc/standard-server-peer';
import { createLineDecoder } from '../connection/create-line-decoder';

export interface StubRequest {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly as: string | undefined;
  readonly asName: string | undefined;
}

export type StubAnswer =
  | { readonly ok: Readonly<Record<string, unknown>> }
  | {
      readonly err: {
        readonly code: string;
        readonly message: string;
        readonly data?: Readonly<Record<string, unknown>>;
      };
    }
  | { readonly line: string }
  | 'close'
  | 'silent';

export interface StubDaemonOptions {
  // answers a request that is not the hello or the event subscription; the default answers {}
  readonly answer?: (request: StubRequest) => StubAnswer;

  // the answer to the hello; the default accepts it
  readonly hello?: (request: StubRequest) => StubAnswer;

  // the features the default hello lists
  readonly features?: readonly string[];
}

const SERIALIZER = new StandardRPCSerializer(new StandardRPCJsonSerializer());

// A daemon that speaks the oRPC peer protocol over a unix socket, one JSON message per line.
// It listens for as long as the test runs, and `stop` ends it.
export async function startStubDaemon(options: StubDaemonOptions = {}) {
  // a unix socket path holds about 100 bytes, which a deep temp folder passes
  const base = tmpdir().length > 50 ? '/tmp' : tmpdir();
  const folder = mkdtempSync(join(base, 'atcx-client-'));
  const path = join(folder, 'daemon.sock');

  const sockets = new Set<Socket>();

  const requests: StubRequest[] = [];

  const subscribers = new Set<(event: Readonly<Record<string, unknown>>) => void>();

  let subscriptions = 0;

  const answerRequest = (stubbed: StubRequest, socket: Socket): Promise<StandardResponse> => {
    requests.push(stubbed);

    if (stubbed.method === 'events.subscribe') {
      subscriptions += 1;

      return Promise.resolve({
        status: 200,
        headers: {},
        body: SERIALIZER.serialize(streamEvents(subscribers, socket)),
      });
    }

    const helloAnswer = options.hello?.(stubbed) ?? {
      ok: buildHelloAnswer(options.features ?? []),
    };

    const otherAnswer = options.answer?.(stubbed) ?? { ok: {} };
    const answer = stubbed.method === 'daemon.hello' ? helloAnswer : otherAnswer;

    return respond(answer, socket);
  };

  const server = createServer((socket) => {
    sockets.add(socket);

    socket.on('close', () => {
      sockets.delete(socket);
    });

    socket.on('error', () => {});

    const lines = createLineDecoder();

    const peer = new ServerPeer((message) => {
      if (typeof message === 'string' && !socket.destroyed) {
        socket.write(`${message}\n`);
      }
    });

    socket.on('close', () => {
      peer.close();
    });

    socket.on('data', (chunk) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;

      for (const line of lines.splitChunk(bytes)) {
        void peer.message(line, (request) => answerRequest(readRequest(request), socket));
      }
    });
  });

  server.listen(path);

  await new Promise<void>((resolve) => {
    server.once('listening', resolve);
  });

  return {
    path,
    requests,
    get subscriptions() {
      return subscriptions;
    },
    get openConnections() {
      return sockets.size;
    },
    emit: (event: Readonly<Record<string, unknown>>) => {
      for (const send of subscribers) {
        send(event);
      }
    },
    dropConnections: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });

      rmSync(folder, { recursive: true, force: true });
    },
  };
}

async function* streamEvents(
  subscribers: Set<(event: Readonly<Record<string, unknown>>) => void>,
  socket: Socket,
): AsyncGenerator<Readonly<Record<string, unknown>>> {
  const queue: Readonly<Record<string, unknown>>[] = [];
  let wake: PromiseWithResolvers<void> | null = null;

  const send = (event: Readonly<Record<string, unknown>>) => {
    queue.push(event);
    wake?.resolve();
  };

  subscribers.add(send);

  socket.once('close', () => {
    wake?.resolve();
  });

  try {
    while (!socket.destroyed) {
      const next = queue.shift();

      if (next === undefined) {
        wake = Promise.withResolvers<void>();

        await wake.promise;
      } else {
        yield next;
      }
    }
  } finally {
    subscribers.delete(send);
  }
}

export function buildHelloAnswer(features: readonly string[]): Readonly<Record<string, unknown>> {
  return {
    daemon: 'atc/stub',
    daemonID: 'd_stub',
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    idempotency: { completedRetentionMs: 60_000 },
    lastUsedAgent: 'claude',
    peerSession: null,
    features,
  };
}

function respond(answer: StubAnswer, socket: Socket): Promise<StandardResponse> {
  if (answer === 'close' || answer === 'silent' || 'line' in answer) {
    if (answer === 'close') {
      socket.end();
    }

    if (typeof answer === 'object' && 'line' in answer) {
      socket.write(`${answer.line}\n`);
    }

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

function readRequest(request: StandardRequest): StubRequest {
  const params: unknown = SERIALIZER.deserialize(request.body);
  const as = request.headers['x-atc-as'];
  const asName = request.headers['x-atc-as-name'];

  return {
    method: request.url.pathname.split('/').filter(Boolean).join('.'),
    params: typeof params === 'object' && params !== null ? { ...params } : {},
    as: typeof as === 'string' ? as : undefined,
    asName: typeof asName === 'string' ? asName : undefined,
  };
}
