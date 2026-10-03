import { randomUUID } from 'node:crypto';
import { DaemonClient } from '../client/daemon-client';
import type { DaemonFeature } from '../protocol/daemon-features';
import { parseDaemonFeatures } from '../protocol/parse-daemon-features';
import { requireDaemonFeatures } from './require-daemon-features';
import type { FleetCaller } from './types';

// The daemon requests the read-only tools send. Each only reads, so running
// one twice is harmless.
const RETRYABLE_METHODS: ReadonlySet<string> = new Set([
  'agents.list',
  'dirs.list',
  'events.read',
  'message.get',
  'report.get',
  'session.get',
  'session.list',
  'session.read',
  'session.resumeCommand',
  'session.screen',
]);

// The effectful requests a daemon takes under an idempotency key, and the
// feature it announces when it does. Under a key, a retry replays the first
// answer instead of running the effect again.
const KEYED_METHODS: ReadonlyMap<string, DaemonFeature> = new Map<string, DaemonFeature>([
  ['session.spawn', 'spawn.idempotency'],
  ['session.message', 'message.idempotency'],
]);

// One handshaken connection and the features its daemon announced.
interface DaemonConnection {
  readonly client: DaemonClient;
  readonly features: ReadonlySet<DaemonFeature>;
}

/**
 * A daemon caller that survives a daemon restart: once the connection ends,
 * the next request opens and handshakes a fresh one. A request that was in
 * flight when the connection ended is retried once on a fresh connection when
 * it is read-only, or when it is a spawn or a message the daemon takes under an
 * idempotency key: the request keeps its key, minted here when the caller
 * passed none, so the daemon runs it at most once. Any other request fails,
 * because a spawn or a message must not run twice.
 */
export class ReconnectingCaller implements FleetCaller {
  private readonly socketPath: string;

  private readonly build: string;

  private client: Promise<DaemonConnection> | null = null;

  private readonly closed = new WeakSet<DaemonClient>();

  constructor(socketPath: string, build: string) {
    this.socketPath = socketPath;
    this.build = build;
  }

  // The required features are checked against each connection right before
  // the request goes out on it, the retry's fresh connection included, since
  // a restart can put an older daemon behind the same socket.
  async sendRequest(
    m: string,
    p?: Readonly<Record<string, unknown>>,
    required: readonly DaemonFeature[] = [],
    principal?: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const opened = await this.openClient();

    requireDaemonFeatures(opened.features, required);

    const keyFeature = KEYED_METHODS.get(m);
    const keyed = keyFeature !== undefined && opened.features.has(keyFeature);
    const params = keyed ? buildKeyedParams(p) : p;

    try {
      return await opened.client.sendRequest(m, params, principal);
    } catch (error) {
      if (!this.closed.has(opened.client) || !(keyed || RETRYABLE_METHODS.has(m))) {
        throw error;
      }

      const fresh = await this.openClient();

      // The fresh daemon has to take the key too, or the retry could run the
      // effect a second time.
      const retryRequired = keyed ? [...required, keyFeature] : required;

      requireDaemonFeatures(fresh.features, retryRequired);

      return fresh.client.sendRequest(m, params, principal);
    }
  }

  // The features of the daemon the next request reaches, read from the
  // handshake of the connection it rides.
  async readFeatures(): Promise<ReadonlySet<DaemonFeature>> {
    const opened = await this.openClient();

    return opened.features;
  }

  async stop(): Promise<void> {
    const current = this.client;

    this.client = null;

    if (current === null) {
      return;
    }

    try {
      const opened = await current;

      opened.client.stop();
    } catch {
      // A connection that never opened has nothing to close.
    }
  }

  private openClient(): Promise<DaemonConnection> {
    if (this.client === null) {
      const opening: Promise<DaemonConnection> = this.openFreshClient(
        () => this.client === opening,
      );

      this.client = opening;
    }

    return this.client;
  }

  // isCurrent returns true while this connection is still the one later requests
  // reuse: a connection that ends after a newer one replaced it must leave
  // the newer one in place.
  private async openFreshClient(isCurrent: () => boolean): Promise<DaemonConnection> {
    const resetClient = () => {
      if (isCurrent()) {
        this.client = null;
      }
    };

    let client: DaemonClient;

    try {
      client = await DaemonClient.open(this.socketPath);
    } catch (error) {
      resetClient();
      throw error;
    }

    client.onClose = () => {
      this.closed.add(client);

      resetClient();
    };

    let hello: Readonly<Record<string, unknown>>;

    try {
      hello = await client.sendHello(this.build);
    } catch (error) {
      client.stop();

      resetClient();
      throw error;
    }

    return { client, features: parseDaemonFeatures(hello) };
  }
}

// The request's params with its idempotency key, minting one when the caller
// passed none.
function buildKeyedParams(
  p: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (typeof p?.['idempotencyKey'] === 'string') {
    return p;
  }

  return { ...p, idempotencyKey: randomUUID() };
}
