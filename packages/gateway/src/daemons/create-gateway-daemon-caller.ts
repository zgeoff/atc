import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import type { Principal } from '@atc/protocol';
import { PROCEDURE_TRAITS } from '@atc/protocol';
import { createDaemonTransport } from '@atc/protocol/wire/transport';
import type { DaemonTransport } from '@atc/protocol/wire/transport';
import { HELLO_RESULT_SCHEMA, checkDaemon } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';
import type { DaemonHello, GatewayChannel, ParamsPreparer, RegistryDaemon } from '../types';
import { GatewayError } from './gateway-error';
import { pickDaemonAdmission } from './pick-daemon-admission';

interface GatewayDaemonCallerOptions {
  readonly daemon: RegistryDaemon;
  readonly build: string;

  readonly openChannel: (
    address: RegistryDaemon['address'],
  ) => GatewayChannel | Promise<GatewayChannel>;

  readonly connectTimeoutMs?: number;
  readonly responseTimeoutMs?: number;

  readonly clock?: Clock;

  readonly onWarning: (message: string) => void;
}

interface OpenConnection {
  readonly channel: GatewayChannel;
  readonly hello: DaemonHello;
}

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

const HANDSHAKE_SCHEMA = HELLO_RESULT_SCHEMA.pick({ daemon: true, features: true });

export function createGatewayDaemonCaller(opts: GatewayDaemonCallerOptions): GatewayDaemonCaller {
  const scheduleTimeout = (onTimeout: () => void, delayMs: number): (() => void) =>
    (opts.clock ?? systemClock).schedule(onTimeout, delayMs);

  const buildOutcomeUnknown = (method: string): AtcError =>
    new AtcError(
      'outcome_unknown',
      `daemon '${opts.daemon.name}' never answered ${method}; check what it did before sending it again`,
      { daemon: opts.daemon.name },
    );

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

      if (error instanceof AtcError && error.code === 'unauthorized') {
        throw new GatewayError(
          'daemon_unauthorized',
          `daemon '${daemon.name}' refused the gateway's token`,
          { daemon: daemon.name },
        );
      }

      if (error instanceof AtcError && error.code === 'no_daemon') {
        throw new GatewayError('daemon_unavailable', `daemon '${daemon.name}' is unreachable`, {
          daemon: daemon.name,
        });
      }

      if (error instanceof AtcError && error.code === 'protocol_mismatch') {
        throw new GatewayError(
          'daemon_unavailable',
          `daemon '${daemon.name}' speaks another protocol version than this gateway; upgrade the older of the two`,
          { daemon: daemon.name, reason: 'daemon_mismatched' },
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

    const handshake = HANDSHAKE_SCHEMA.safeParse(answer);

    if (!handshake.success) {
      channel.stop();

      throw new GatewayError(
        'daemon_unavailable',
        `daemon '${daemon.name}' answered a handshake outside the atc contract`,
        { daemon: daemon.name, reason: 'daemon_mismatched' },
      );
    }

    const hello = buildDaemonHello(answer, daemon.daemonID);

    const admission = pickDaemonAdmission(
      daemon.name,
      handshake.data.daemon,
      checkDaemon(handshake.data),
    );

    if (admission.kind === 'refuse') {
      channel.stop();

      throw new GatewayError('daemon_unavailable', admission.message, {
        daemon: daemon.name,
        reason: 'daemon_mismatched',
      });
    }

    if (admission.kind === 'warn') {
      opts.onWarning(admission.message);
    }

    return { channel, hello };
  };

  const openTimedConnection = async (): Promise<OpenConnection> => {
    const daemon = opts.daemon;
    const timeout = Promise.withResolvers<'timeout'>();

    const cancelTimeout = scheduleTimeout(() => {
      timeout.resolve('timeout');
    }, opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

    let timedOut = false;

    // Promise.race leaves the loser unobserved, so a late failure would be an unhandled rejection.
    // Return errors as values instead.
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
    const channel = connection.channel;
    const sent = prepareParams(request.params);
    const timeout = Promise.withResolvers<'timeout'>();
    const waitMs = typeof sent['waitMs'] === 'number' && sent['waitMs'] > 0 ? sent['waitMs'] : 0;

    const cancelTimeout = scheduleTimeout(
      () => {
        timeout.resolve('timeout');
      },
      (opts.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS) + waitMs,
    );

    // Promise.race leaves the loser unobserved, so a late rejection would be unhandled.
    // Return errors as values instead.
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

    if (raced.error instanceof AtcError && raced.error.code === 'idempotency_key_unknown') {
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
