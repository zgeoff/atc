import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import type { Principal } from '@atc/protocol';
import { PROCEDURE_TRAITS } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import { createDaemonTransport } from '@atc/protocol/wire/transport';
import type { DaemonTransport } from '@atc/protocol/wire/transport';
import { GatewayError } from './gateway-error';
import type { DaemonHello, GatewayChannel, ParamsPreparer, RegistryDaemon } from './types';

interface GatewayDaemonCallerOptions {
  readonly daemon: RegistryDaemon;
  readonly build: string;

  // Connects to the daemon's TCP address.
  readonly openChannel: (address: RegistryDaemon['address']) => Promise<GatewayChannel>;

  // How long the connect and the handshake may take together, and how long
  // a sent request may wait for its response.
  readonly connectTimeoutMs?: number;
  readonly responseTimeoutMs?: number;

  // Runs the connect and response timers; the system clock when unset.
  readonly clock?: Clock;
}

// One handshaken connection and what its handshake returned.
interface OpenConnection {
  readonly channel: GatewayChannel;
  readonly hello: DaemonHello;
}

// A connection as a request reads it, which never replaces its callback.
type SendingConnection = Readonly<{ channel: Readonly<GatewayChannel>; hello: DaemonHello }>;

interface GatewayRequest {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly as: Principal | undefined;
}

const CONNECT_TIMEOUT_MS = 10_000;
const RESPONSE_TIMEOUT_MS = 30_000;

export interface GatewayDaemonCaller {
  readonly sendRequest: (
    method: string,
    requestParams?: Readonly<Record<string, unknown>>,
    as?: Principal,
    prepareParams?: ParamsPreparer,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly readHello: () => Promise<DaemonHello>;
  readonly stop: () => Promise<void>;
}

export function createGatewayDaemonCaller(opts: GatewayDaemonCallerOptions): GatewayDaemonCaller {
  const scheduleTimeout = (onTimeout: () => void, delayMs: number): (() => void) =>
    (opts.clock ?? systemClock).schedule(onTimeout, delayMs);

  const buildOutcomeUnknown = (method: string): DaemonError =>
    new DaemonError(
      'outcome_unknown',
      `daemon '${opts.daemon.name}' never answered ${method}; check what it did before sending it again`,
      { daemon: opts.daemon.name },
    );

  // Connects and handshakes, refusing a daemon behind another state
  // identity than the pin before anything is sent to it.
  const openHandshaken = async (): Promise<OpenConnection> => {
    const daemon = opts.daemon;
    let channel: GatewayChannel;

    try {
      channel = await opts.openChannel(daemon.address);
    } catch {
      throw new GatewayError('daemon_unavailable', `daemon '${daemon.name}' is unreachable`, {
        daemon: daemon.name,
      });
    }

    let answer: Readonly<Record<string, unknown>>;

    try {
      answer = await channel.sendRequest('daemon.hello', {
        client: opts.build,
        auth: { scheme: 'bearer', token: daemon.token },
      });
    } catch (error) {
      channel.stop();

      if (error instanceof DaemonError && error.code === 'unauthorized') {
        throw new GatewayError(
          'daemon_unauthorized',
          `daemon '${daemon.name}' refused the gateway's token`,
          { daemon: daemon.name },
        );
      }

      throw new GatewayError(
        'daemon_unavailable',
        `daemon '${daemon.name}' did not complete the handshake`,
        { daemon: daemon.name },
      );
    }

    if (answer['daemonID'] !== daemon.daemonID) {
      channel.stop();

      throw new GatewayError(
        'daemon_unavailable',
        `daemon '${daemon.name}' answers with another state identity than the registry pins`,
        { daemon: daemon.name, reason: 'daemon_changed' },
      );
    }

    return { channel, hello: buildDaemonHello(answer, daemon.daemonID) };
  };

  // Connects and handshakes within the connect time, stopping a connection
  // that opens after the time ran out, so a late open never leaks.
  const openTimedConnection = async (): Promise<OpenConnection> => {
    const daemon = opts.daemon;
    const timeout = Promise.withResolvers<'timeout'>();

    const cancelTimeout = scheduleTimeout(() => {
      timeout.resolve('timeout');
    }, opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

    let timedOut = false;

    // Settles as a value either way, so an open that fails after the
    // timeout won never goes unhandled.
    const handshaken = (async () => {
      try {
        const late = await openHandshaken();

        if (timedOut) {
          late.channel.stop();
        }

        return { kind: 'opened' as const, opened: late };
      } catch (error) {
        return { kind: 'failed' as const, error };
      }
    })();

    try {
      const raced = await Promise.race([handshaken, timeout.promise]);

      if (raced === 'timeout') {
        timedOut = true;

        throw new GatewayError(
          'daemon_unavailable',
          `daemon '${daemon.name}' did not answer the connection in time`,
          { daemon: daemon.name },
        );
      }

      if (raced.kind === 'failed') {
        throw raced.error;
      }

      return raced.opened;
    } finally {
      cancelTimeout();
    }
  };

  const transport: DaemonTransport<OpenConnection> = createDaemonTransport({
    reconnect: 'on-demand',
    open: () => openTimedConnection(),
    getChannel: (connection) => connection.channel,
  });

  const trySend = async (
    connection: SendingConnection,
    request: GatewayRequest,
    prepareParams: ParamsPreparer,
  ): Promise<
    | { readonly kind: 'answered'; readonly ok: Readonly<Record<string, unknown>> }
    | { readonly kind: 'lost' }
  > => {
    // Runs in the same synchronous step as the write below, after the
    // connection's handshake, so whatever it decides still holds when the
    // request leaves.
    const channel = connection.channel;
    const sent = prepareParams(request.params);
    const timeout = Promise.withResolvers<'timeout'>();

    // A request that waits for a change on the daemon, such as a long poll,
    // gets its own wait on top of the response time.
    const waitMs = typeof sent['waitMs'] === 'number' && sent['waitMs'] > 0 ? sent['waitMs'] : 0;

    const cancelTimeout = scheduleTimeout(
      () => {
        timeout.resolve('timeout');
      },
      (opts.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS) + waitMs,
    );

    // Settles as a value either way, so a response that rejects after the
    // timeout won never goes unhandled.
    const settled = (async () => {
      try {
        return {
          kind: 'ok' as const,
          ok: await channel.sendRequest(request.method, sent, request.as?.id, request.as?.name),
        };
      } catch (error) {
        return { kind: 'error' as const, error };
      }
    })();

    const raced = await Promise.race([settled, timeout.promise]);

    cancelTimeout();

    // A response that may still arrive leaves its connection out of
    // service, so later requests open a fresh one.
    if (raced === 'timeout') {
      transport.stopConnection(connection);

      return { kind: 'lost' };
    }

    if (raced.kind === 'ok') {
      return { kind: 'answered', ok: raced.ok };
    }

    if (transport.isLost(connection)) {
      return { kind: 'lost' };
    }

    // a replay-only request gets this for a key the daemon never held or has dropped
    if (raced.error instanceof DaemonError && raced.error.code === 'idempotency_key_unknown') {
      throw buildOutcomeUnknown(request.method);
    }

    throw raced.error;
  };

  return {
    sendRequest: async (method, givenParams, as, prepareParams = (params) => params) => {
      const requestParams = givenParams ?? {};
      const request = { method, params: requestParams, as };

      const opened = await transport.waitForConnection();
      const first = await trySend(opened, request, prepareParams);

      if (first.kind === 'answered') {
        return first.ok;
      }

      const keyed =
        typeof requestParams['idempotencyKey'] === 'string' &&
        PROCEDURE_TRAITS.get(method)?.keyed === true;

      const repeatable = PROCEDURE_TRAITS.get(method)?.readOnly === true || keyed;

      if (!repeatable) {
        throw buildOutcomeUnknown(method);
      }

      let fresh: OpenConnection;

      try {
        fresh = await transport.waitForConnection();
      } catch {
        throw buildOutcomeUnknown(method);
      }

      // a keyed retry only ever replays, so a daemon whose first send never arrived, or that
      // has dropped the key since, runs nothing a second time
      const second = await trySend(fresh, request, (params) =>
        keyed ? { ...prepareParams(params), replayOnly: true } : prepareParams(params),
      );

      if (second.kind === 'answered') {
        return second.ok;
      }

      throw buildOutcomeUnknown(method);
    },

    readHello: async () => {
      const opened = await transport.waitForConnection();

      return opened.hello;
    },

    stop: () => {
      transport.stop();

      return Promise.resolve();
    },
  };
}

function buildDaemonHello(
  answer: Readonly<Record<string, unknown>>,
  daemonID: string,
): DaemonHello {
  const idempotency = answer['idempotency'];

  const retention: unknown =
    typeof idempotency === 'object' && idempotency !== null
      ? Reflect.get(idempotency, 'completedRetentionMs')
      : undefined;

  return {
    build: typeof answer['daemon'] === 'string' ? answer['daemon'] : 'unknown',
    daemonID,
    retentionMs: typeof retention === 'number' && retention > 0 ? retention : null,
  };
}
