import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import type { DaemonFeature, Principal } from '@atc/protocol';
import { KEYED_METHOD_FEATURES, PROCEDURE_TRAITS, parseDaemonFeatures } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import { DaemonTransport } from '@atc/protocol/wire/transport';
import { buildDaemonOutdatedError } from './build-daemon-outdated-error';
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

const CONNECT_TIMEOUT_MS = 10_000;
const RESPONSE_TIMEOUT_MS = 30_000;

export class GatewayDaemonCaller {
  private readonly opts: GatewayDaemonCallerOptions;

  private readonly transport: DaemonTransport<OpenConnection>;

  constructor(opts: GatewayDaemonCallerOptions) {
    this.opts = opts;

    this.transport = new DaemonTransport({
      reconnect: 'on-demand',
      open: () => this.openTimedConnection(),
      getChannel: (connection) => connection.channel,
    });
  }

  async sendRequest(
    m: string,
    p: Readonly<Record<string, unknown>> = {},
    as?: Principal,
    required: readonly DaemonFeature[] = [],
    prepareParams: ParamsPreparer = (params) => params,
  ): Promise<Readonly<Record<string, unknown>>> {
    // A request that acts as a principal relies on the daemon honouring it,
    // and on the daemon labelling a message with the principal's name.
    const needed: readonly DaemonFeature[] =
      as === undefined ? required : [...required, 'request.principal', 'message.sender'];

    const opened = await this.transport.waitForConnection();

    const unserved = needed.find((feature) => !opened.hello.features.has(feature));

    if (unserved !== undefined) {
      throw buildDaemonOutdatedError(this.opts.daemon.name, unserved);
    }

    const first = await this.trySend(opened, m, p, as, prepareParams);

    if (first.kind === 'answered') {
      return first.ok;
    }

    const keyFeature =
      typeof p['idempotencyKey'] === 'string' ? KEYED_METHOD_FEATURES.get(m) : undefined;

    const repeatable = PROCEDURE_TRAITS.get(m)?.readOnly === true || keyFeature !== undefined;

    if (!repeatable) {
      throw this.buildOutcomeUnknown(m);
    }

    let fresh: OpenConnection;

    try {
      fresh = await this.transport.waitForConnection();
    } catch {
      throw this.buildOutcomeUnknown(m);
    }

    // a keyed retry only ever replays, and only to a daemon that announces the key and
    // replay-only requests, so a daemon whose first send never arrived, or that has dropped
    // the key since, runs nothing a second time
    const replays =
      keyFeature !== undefined &&
      fresh.hello.features.has(keyFeature) &&
      fresh.hello.features.has('idempotency.replayOnly');

    if (keyFeature !== undefined && !replays) {
      throw this.buildOutcomeUnknown(m);
    }

    // Nor does a retry reach a connection whose daemon would ignore what
    // the request relies on, such as the principal it acts as.
    if (needed.some((feature) => !fresh.hello.features.has(feature))) {
      throw this.buildOutcomeUnknown(m);
    }

    const second = await this.trySend(fresh, m, p, as, (params) =>
      replays ? { ...prepareParams(params), replayOnly: true } : prepareParams(params),
    );

    if (second.kind === 'answered') {
      return second.ok;
    }

    throw this.buildOutcomeUnknown(m);
  }

  async readHello(): Promise<DaemonHello> {
    const opened = await this.transport.waitForConnection();

    return opened.hello;
  }

  stop(): Promise<void> {
    this.transport.stop();

    return Promise.resolve();
  }

  private async trySend(
    connection: SendingConnection,
    m: string,
    p: Readonly<Record<string, unknown>>,
    as: Principal | undefined,
    prepareParams: ParamsPreparer,
  ): Promise<
    | { readonly kind: 'answered'; readonly ok: Readonly<Record<string, unknown>> }
    | { readonly kind: 'lost' }
  > {
    // Runs in the same synchronous step as the write below, after the
    // connection's handshake, so whatever it decides still holds when the
    // request leaves.
    const channel = connection.channel;
    const sent = prepareParams(p);

    if (sent['replayOnly'] === true && !connection.hello.features.has('idempotency.replayOnly')) {
      throw this.buildOutcomeUnknown(m);
    }

    const timeout = Promise.withResolvers<'timeout'>();

    // A request that waits for a change on the daemon, such as a long poll,
    // gets its own wait on top of the response time.
    const waitMs = typeof sent['waitMs'] === 'number' && sent['waitMs'] > 0 ? sent['waitMs'] : 0;

    const cancelTimeout = this.scheduleTimeout(
      () => {
        timeout.resolve('timeout');
      },
      (this.opts.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS) + waitMs,
    );

    // Settles as a value either way, so a response that rejects after the
    // timeout won never goes unhandled.
    const settled = (async () => {
      try {
        return { kind: 'ok' as const, ok: await channel.sendRequest(m, sent, as?.id, as?.name) };
      } catch (error) {
        return { kind: 'error' as const, error };
      }
    })();

    const raced = await Promise.race([settled, timeout.promise]);

    cancelTimeout();

    // A response that may still arrive leaves its connection out of
    // service, so later requests open a fresh one.
    if (raced === 'timeout') {
      this.transport.stopConnection(connection);

      return { kind: 'lost' };
    }

    if (raced.kind === 'ok') {
      return { kind: 'answered', ok: raced.ok };
    }

    if (this.transport.isLost(connection)) {
      return { kind: 'lost' };
    }

    // a replay-only request gets this for a key the daemon never held or has dropped
    if (raced.error instanceof DaemonError && raced.error.code === 'idempotency_key_unknown') {
      throw this.buildOutcomeUnknown(m);
    }

    throw raced.error;
  }

  private scheduleTimeout(onTimeout: () => void, ms: number): () => void {
    return (this.opts.clock ?? systemClock).schedule(onTimeout, ms);
  }

  private buildOutcomeUnknown(m: string): DaemonError {
    return new DaemonError(
      'outcome_unknown',
      `daemon '${this.opts.daemon.name}' never answered ${m}; check what it did before sending it again`,
      { daemon: this.opts.daemon.name },
    );
  }

  // Connects and handshakes within the connect time, stopping a connection
  // that opens after the time ran out, so a late open never leaks.
  private async openTimedConnection(): Promise<OpenConnection> {
    const daemon = this.opts.daemon;
    const timeout = Promise.withResolvers<'timeout'>();

    const cancelTimeout = this.scheduleTimeout(() => {
      timeout.resolve('timeout');
    }, this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

    let timedOut = false;

    // Settles as a value either way, so an open that fails after the
    // timeout won never goes unhandled.
    const handshaken = (async () => {
      try {
        const late = await this.openHandshaken();

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
  }

  // Connects and handshakes, refusing a daemon behind another state
  // identity than the pin before anything is sent to it.
  private async openHandshaken(): Promise<OpenConnection> {
    const daemon = this.opts.daemon;
    let channel: GatewayChannel;

    try {
      channel = await this.opts.openChannel(daemon.address);
    } catch {
      throw new GatewayError('daemon_unavailable', `daemon '${daemon.name}' is unreachable`, {
        daemon: daemon.name,
      });
    }

    let answer: Readonly<Record<string, unknown>>;

    try {
      answer = await channel.sendRequest('daemon.hello', {
        client: this.opts.build,
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
  }
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
    features: parseDaemonFeatures(answer),
    retentionMs: typeof retention === 'number' && retention > 0 ? retention : null,
  };
}
