import { DaemonError } from '../protocol/daemon-error';
import type { DaemonFeature } from '../protocol/daemon-features';
import { parseDaemonFeatures } from '../protocol/parse-daemon-features';
import { buildDaemonOutdatedError } from './build-daemon-outdated-error';
import { GatewayError } from './gateway-error';
import type { RegistryDaemon } from './types';

/**
 * One open protocol connection to a daemon, as the caller drives it:
 * correlated requests, a callback for when the connection ends, and closing
 * it. A request that rejects after the callback fired got no response.
 */
export interface GatewayChannel {
  onClose: () => void;
  readonly sendRequest: (
    m: string,
    p?: Readonly<Record<string, unknown>>,
    as?: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly stop: () => void;
}

/**
 * What a daemon's handshake told the gateway: its build, its state
 * identity, the features it serves, and how long it keeps a completed
 * idempotency key, null when it announced none.
 */
export interface DaemonHello {
  readonly build: string;
  readonly daemonID: string;
  readonly features: ReadonlySet<DaemonFeature>;
  readonly retentionMs: number | null;
}

interface DaemonCallerOptions {
  readonly daemon: RegistryDaemon;
  readonly build: string;

  // Connects to the daemon's TCP address.
  readonly openChannel: (address: RegistryDaemon['address']) => Promise<GatewayChannel>;

  // How long the connect and the handshake may take together, and how long
  // a sent request may wait for its response.
  readonly connectTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
}

// One handshaken connection and what its handshake returned.
interface OpenConnection {
  readonly channel: GatewayChannel;
  readonly hello: DaemonHello;
}

// The requests that only read, so a second run is harmless.
const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  'agents.list',
  'dirs.list',
  'events.read',
  'message.get',
  'session.get',
  'session.list',
  'session.read',
  'session.resumeCommand',
  'session.screen',
]);

// The requests a daemon runs at most once under an idempotency key, and the
// feature a daemon announces when it does.
const KEYED_METHODS: ReadonlyMap<string, DaemonFeature> = new Map<string, DaemonFeature>([
  ['session.spawn', 'spawn.idempotency'],
  ['session.message', 'message.idempotency'],
]);

const CONNECT_TIMEOUT_MS = 10_000;
const RESPONSE_TIMEOUT_MS = 30_000;

/**
 * The gateway's caller for one named daemon: it dials the daemon's TCP
 * address with the daemon's bearer token, keeps one connection open, and
 * sends nothing to a daemon whose handshake returns another `daemonID`
 * than the registry pins. A failure before the request leaves is
 * `daemon_unavailable`, or `daemon_unauthorized` for a refused token. A
 * request sent whose response never arrives, because the connection ended
 * or 30 s passed beyond the request's own `waitMs`, is never a failure: a
 * keyed or read-only request is sent once more on a fresh connection to
 * the same daemon. A keyed retry goes out replay-only, under the same key,
 * and only while that connection announces both the key's feature and
 * replay-only requests; a daemon that holds no such key answers it
 * `idempotency_key_unknown`, which ends as `outcome_unknown`.
 * Any other request, a reconnect without that feature, or a second loss is
 * `outcome_unknown`. A daemon's
 * own error passes through as it came.
 */
export class DaemonCaller {
  private readonly opts: DaemonCallerOptions;

  private connection: Promise<OpenConnection> | null = null;

  // The channel of the connection later requests reuse, once it is open.
  private current: GatewayChannel | null = null;

  private readonly closed = new WeakSet<GatewayChannel>();

  constructor(opts: DaemonCallerOptions) {
    this.opts = opts;
  }

  async sendRequest(
    m: string,
    p: Readonly<Record<string, unknown>> = {},
    as?: string,
    required: readonly DaemonFeature[] = [],
  ): Promise<Readonly<Record<string, unknown>>> {
    // A request that acts as a principal relies on the daemon honouring it.
    const needed: readonly DaemonFeature[] =
      as === undefined ? required : [...required, 'request.principal'];

    const opened = await this.openConnection();

    const unserved = needed.find((feature) => !opened.hello.features.has(feature));

    if (unserved !== undefined) {
      throw buildDaemonOutdatedError(this.opts.daemon.name, unserved);
    }

    const first = await this.trySend(opened.channel, m, p, as);

    if (first.kind === 'answered') {
      return first.ok;
    }

    const keyFeature = typeof p['idempotencyKey'] === 'string' ? KEYED_METHODS.get(m) : undefined;
    const repeatable = READ_ONLY_METHODS.has(m) || keyFeature !== undefined;

    if (!repeatable) {
      throw this.buildOutcomeUnknown(m);
    }

    let fresh: OpenConnection;

    try {
      fresh = await this.openConnection();
    } catch {
      throw this.buildOutcomeUnknown(m);
    }

    // A keyed retry only ever replays: it goes out replay-only, and only to
    // a daemon that announces it takes the key and replay-only requests, so
    // a daemon whose first send never arrived, or that has dropped the key
    // since, runs nothing a second time.
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

    const retryParams = replays ? { ...p, replayOnly: true } : p;
    let second: Awaited<ReturnType<DaemonCaller['trySend']>>;

    try {
      second = await this.trySend(fresh.channel, m, retryParams, as);
    } catch (error) {
      if (error instanceof DaemonError && error.code === 'idempotency_key_unknown') {
        throw this.buildOutcomeUnknown(m);
      }

      throw error;
    }

    if (second.kind === 'answered') {
      return second.ok;
    }

    throw this.buildOutcomeUnknown(m);
  }

  /**
   * The handshake of the connection the next request rides, opening one
   * when none is open.
   */
  async readHello(): Promise<DaemonHello> {
    const opened = await this.openConnection();

    return opened.hello;
  }

  async stop(): Promise<void> {
    const current = this.connection;

    this.connection = null;

    if (current === null) {
      return;
    }

    try {
      const opened = await current;

      opened.channel.stop();
    } catch {
      // A connection that never opened has nothing to close.
    }
  }

  // Sends one request, answering with the daemon's answer, or with `lost`
  // when no response arrived. A daemon's error rejects as it came.
  private async trySend(
    channel: Readonly<GatewayChannel>,
    m: string,
    p: Readonly<Record<string, unknown>>,
    as: string | undefined,
  ): Promise<
    | { readonly kind: 'answered'; readonly ok: Readonly<Record<string, unknown>> }
    | { readonly kind: 'lost' }
  > {
    const timeout = Promise.withResolvers<'timeout'>();

    // A request that waits for a change on the daemon, such as a long poll,
    // gets its own wait on top of the response time.
    const waitMs = typeof p['waitMs'] === 'number' && p['waitMs'] > 0 ? p['waitMs'] : 0;

    const timer = setTimeout(
      () => {
        timeout.resolve('timeout');
      },
      (this.opts.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS) + waitMs,
    );

    // Settles as a value either way, so a response that rejects after the
    // timeout won never goes unhandled.
    const settled = (async () => {
      try {
        return { kind: 'ok' as const, ok: await channel.sendRequest(m, p, as) };
      } catch (error) {
        return { kind: 'error' as const, error };
      }
    })();

    const raced = await Promise.race([settled, timeout.promise]);

    clearTimeout(timer);

    if (raced === 'timeout') {
      this.closed.add(channel);
      this.resetCurrentConnection(channel);
      channel.stop();

      return { kind: 'lost' };
    }

    if (raced.kind === 'ok') {
      return { kind: 'answered', ok: raced.ok };
    }

    if (this.closed.has(channel)) {
      return { kind: 'lost' };
    }

    throw raced.error;
  }

  // Stops later requests from reusing the channel's connection, which a
  // timed-out request leaves with a response that may still arrive.
  private resetCurrentConnection(channel: Readonly<GatewayChannel>): void {
    if (this.current === channel) {
      this.current = null;
      this.connection = null;
    }
  }

  private buildOutcomeUnknown(m: string): DaemonError {
    return new DaemonError(
      'outcome_unknown',
      `daemon '${this.opts.daemon.name}' never answered ${m}; check what it did before sending it again`,
      { daemon: this.opts.daemon.name },
    );
  }

  private openConnection(): Promise<OpenConnection> {
    if (this.connection === null) {
      const opening: Promise<OpenConnection> = this.openFreshConnection(
        () => this.connection === opening,
      );

      this.connection = opening;
    }

    return this.connection;
  }

  // isCurrent returns true while this connection is the one later requests
  // reuse: a connection that ends after a newer one replaced it leaves the
  // newer one in place.
  private async openFreshConnection(isCurrent: () => boolean): Promise<OpenConnection> {
    const daemon = this.opts.daemon;

    const resetConnection = () => {
      if (isCurrent()) {
        this.connection = null;
      }
    };

    const timeout = Promise.withResolvers<'timeout'>();

    const timer = setTimeout(() => {
      timeout.resolve('timeout');
    }, this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

    let timedOut = false;

    // Settles as a value either way, and stops a connection that opens
    // after the timeout won, so a late open never leaks.
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

      const opened = raced.opened;

      opened.channel.onClose = () => {
        this.closed.add(opened.channel);

        resetConnection();
      };

      if (isCurrent()) {
        this.current = opened.channel;
      }

      return opened;
    } catch (error) {
      resetConnection();
      throw error;
    } finally {
      clearTimeout(timer);
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
