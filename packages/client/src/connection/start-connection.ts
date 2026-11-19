import { once } from 'node:events';
import type { Socket } from 'node:net';
import type {
  DAEMON_CONTRACT,
  DAEMON_EVENT_SCHEMA,
  DaemonEvent,
  DaemonProcedures,
  HELLO_RESULT_SCHEMA,
  PROCEDURE_META_SCHEMA,
} from '@atcx/contract';
import { AtcError, CONTRACT_MAJOR, PRINCIPAL_HEADERS, PROTOCOL_V } from '@atcx/contract/light';
import { createORPCClient } from '@orpc/client';
import { StandardRPCLink } from '@orpc/client/standard';
import { ClientPeer } from '@orpc/standard-server-peer';
import { createEventFanOut } from './create-event-fan-out';
import { createLineDecoder } from './create-line-decoder';
import type {
  CallContext,
  DaemonConnection,
  DaemonConnectionOptions,
  DaemonHello,
  DaemonTarget,
} from './daemon-connection';
import { findMissingFeature } from './find-missing-feature';
import { toAtcError } from './to-atc-error';
import type { ProcedureTraits } from './to-atc-error';

// The parts of the contract that a connection needs, which the caller loads on demand so that a
// process that starts once per event never pays for the contract's schemas.
export interface ContractParts {
  readonly DAEMON_CONTRACT: typeof DAEMON_CONTRACT;
  readonly DAEMON_EVENT_SCHEMA: typeof DAEMON_EVENT_SCHEMA;
  readonly HELLO_RESULT_SCHEMA: typeof HELLO_RESULT_SCHEMA;
  readonly PROCEDURE_META_SCHEMA: typeof PROCEDURE_META_SCHEMA;
}

// The most bytes the outbound queue holds. A write that would pass it ends the connection.
const QUEUE_BYTES = 8 * 1024 * 1024;

export async function waitForConnect(socket: Socket, target: DaemonTarget): Promise<void> {
  try {
    await once(socket, 'connect');
  } catch (error) {
    const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined;
    const tried = 'path' in target ? target.path : `${target.hostname}:${target.port}`;

    if (code === 'ENOENT' || code === 'ECONNREFUSED') {
      throw new AtcError('no_daemon', `no atc daemon listens at ${tried}`, { tried: [tried] });
    }

    throw new AtcError(
      'internal',
      `could not connect to ${tried}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// The socket is open. The promise settles with the daemon's answer to the hello.
export function startConnection(
  socket: Socket,
  contract: ContractParts,
  greeting: DaemonHello,
  options: DaemonConnectionOptions,
): Promise<DaemonConnection> {
  const traits = collectProcedureTraits(contract);

  const kinds = new Set(
    contract.DAEMON_EVENT_SCHEMA.options.map((option) => option.shape.ev.value),
  );

  const fanOut = createEventFanOut<DaemonEvent>();
  const closed = Promise.withResolvers<void>();
  const lines = createLineDecoder();
  const helloFailure = Promise.withResolvers<never>();

  const state = {
    closed: false,
    accepted: false,
    subscribed: false,
    inbound: Promise.resolve(),
  };

  let features: readonly string[] | null = null;

  // Ends calls and iterators at once; the socket's own close event settles `closed`.
  const markClosed = (message: string) => {
    if (state.closed) {
      return;
    }

    state.closed = true;

    peer.close({ reason: new AtcError('connection_lost', message) });
    fanOut.end();
  };

  const terminate = (message: string) => {
    markClosed(message);

    socket.destroy();
  };

  const peer: ClientPeer = new ClientPeer((message) => {
    const line = `${typeof message === 'string' ? message : ''}\n`;

    if (
      typeof message !== 'string' ||
      socket.writableLength + Buffer.byteLength(line) > QUEUE_BYTES
    ) {
      terminate('the outbound queue is full');
      throw new AtcError('connection_lost', 'the outbound queue is full');
    }

    socket.write(line);
  });

  const link = new StandardRPCLink<CallContext>(
    {
      call: async (request) => {
        if (state.closed) {
          throw new AtcError('connection_lost', 'the connection is closed');
        }

        const response = await peer.request(request);

        return { ...response, body: () => Promise.resolve(response.body) };
      },
    },
    {
      url: 'http://orpc',
      headers: (linkOptions) => {
        const as = linkOptions.context.as ?? greeting.principal;

        return {
          ...(as === undefined ? {} : { [PRINCIPAL_HEADERS.as]: as }),
          ...(as === undefined || linkOptions.context.asName === undefined
            ? {}
            : { [PRINCIPAL_HEADERS.asName]: linkOptions.context.asName }),
        };
      },
      interceptors: [
        async (linkOptions) => {
          const method = linkOptions.path.join('.');

          const missing =
            features === null ? null : findMissingFeature(method, linkOptions.input, features);

          if (missing !== null) {
            throw new AtcError(
              'feature_missing',
              `${method} input ${missing.field} needs the daemon feature ${missing.feature}; restart the daemon on a newer atc`,
            );
          }

          try {
            const answer: unknown = await linkOptions.next();

            if (
              typeof answer === 'object' &&
              answer !== null &&
              !(Symbol.asyncIterator in answer)
            ) {
              notifyAnswer(method, Object.fromEntries(Object.entries(answer)));
            }

            return answer;
          } catch (error) {
            throw toAtcError(error, method, traits.get(method));
          }
        },
      ],
    },
  );

  const notifyAnswer = (method: string, answer: Readonly<Record<string, unknown>>) => {
    try {
      options.onAnswer?.(method, answer);
    } catch (error) {
      throw new AtcError('internal', String(error));
    }
  };

  const procedures: DaemonProcedures<CallContext> = createORPCClient(link);

  socket.on('data', (chunk) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;

    for (const line of lines.splitChunk(bytes)) {
      state.inbound = applyLine(state.inbound, line);
    }
  });

  const applyLine = async (previous: Promise<void>, line: string): Promise<void> => {
    await previous;

    try {
      await peer.message(line);
    } catch {
      // a daemon from before oRPC answers the hello with a line that is no peer message
      if (!state.accepted) {
        helloFailure.reject(
          new AtcError(
            'protocol_mismatch',
            'the daemon answered the hello with a message that is not an oRPC peer message; it runs an older atc',
          ),
        );
      }

      socket.destroy();
    }
  };

  socket.on('close', () => {
    void (async () => {
      await state.inbound;

      markClosed('the connection closed');

      closed.resolve();
    })();
  });

  const pumpEvents = async () => {
    let reason = 'the daemon ended the event subscription';

    try {
      const stream = await procedures.events.subscribe({}, { context: {} });

      for await (const event of stream) {
        if (kinds.has(event.ev)) {
          fanOut.push(event);
        }
      }
    } catch (error) {
      reason = `the event subscription failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    terminate(reason);
  };

  const sayHello = async (): Promise<DaemonConnection> => {
    const answer = await link.call(
      ['daemon', 'hello'],
      {
        client: greeting.client,
        protocol: PROTOCOL_V,
        major: CONTRACT_MAJOR,
        auth:
          greeting.token === undefined
            ? { scheme: 'none' }
            : { scheme: 'bearer', token: greeting.token },
        ...(greeting.session === undefined ? {} : { session: greeting.session }),
        ...(greeting.principal === undefined ? {} : { principal: greeting.principal }),
        ...(greeting.viewer === undefined ? {} : { viewer: greeting.viewer }),
      },
      { context: {} },
    );

    const parsed = contract.HELLO_RESULT_SCHEMA.safeParse(answer);

    if (!parsed.success) {
      throw new AtcError(
        'protocol_mismatch',
        'the daemon answered the hello outside the atc contract',
      );
    }

    features = parsed.data.features;
    state.accepted = true;

    return {
      hello: parsed.data,
      procedures,
      request: (method, params, context) =>
        link.call(method.split('.'), params ?? {}, { context: context ?? {} }),
      events: (eventOptions) => {
        if (!state.subscribed && !state.closed) {
          state.subscribed = true;
          void pumpEvents();
        }

        return fanOut.subscribe(eventOptions?.signal);
      },
      closed: closed.promise,
      close: async () => {
        markClosed('the client closed the connection');

        socket.destroySoon();

        await closed.promise;
      },
    };
  };

  return raceHello(sayHello(), helloFailure.promise);
}

function collectProcedureTraits(contract: ContractParts): ReadonlyMap<string, ProcedureTraits> {
  const traits = new Map<string, ProcedureTraits>();

  const visit = (node: unknown, path: readonly string[]) => {
    if (typeof node !== 'object' || node === null) {
      return;
    }

    const definition: unknown = Reflect.get(node, '~orpc');

    if (typeof definition === 'object' && definition !== null && 'meta' in definition) {
      const meta = contract.PROCEDURE_META_SCHEMA.parse(definition.meta);

      traits.set(path.join('.'), { readOnly: meta.readOnly, keyed: meta.keyed });

      return;
    }

    for (const [key, child] of Object.entries(node)) {
      visit(child, [...path, key]);
    }
  };

  visit(contract.DAEMON_CONTRACT, []);

  return traits;
}

async function raceHello(
  hello: Promise<DaemonConnection>,
  failure: Promise<never>,
): Promise<DaemonConnection> {
  try {
    return await Promise.race([hello, failure]);
  } catch (error) {
    throw toAtcError(error, 'daemon.hello', undefined);
  }
}
