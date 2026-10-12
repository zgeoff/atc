import { randomUUID } from 'node:crypto';
import type { DaemonChannel } from '@atc/protocol/daemon-channel';
import type { DaemonFeature } from '@atc/protocol/daemon-features';
import { KEYED_METHOD_FEATURES } from '@atc/protocol/keyed-method-features';
import { parseDaemonFeatures } from '@atc/protocol/parse-daemon-features';
import { PROCEDURE_TRAITS } from '@atc/protocol/procedure-traits';
import { readSessionEnv } from '@atc/protocol/read-session-env';
import { requireDaemonFeatures } from './require-daemon-features';
import type { FleetCaller } from './types';

// One handshaken connection and the features its daemon announced.
interface DaemonConnection {
  readonly client: DaemonChannel;
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

  private readonly openChannel: (socketPath: string) => Promise<DaemonChannel>;

  private client: Promise<DaemonConnection> | null = null;

  private readonly closed = new WeakSet<DaemonChannel>();

  // The last argument connects to the daemon at a socket path; each channel
  // it returns is handshaken here before a request rides it.
  constructor(
    socketPath: string,
    build: string,
    openChannel: (socketPath: string) => Promise<DaemonChannel>,
  ) {
    this.socketPath = socketPath;
    this.build = build;
    this.openChannel = openChannel;
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

    const keyFeature = KEYED_METHOD_FEATURES.get(m);
    const keyed = keyFeature !== undefined && opened.features.has(keyFeature);
    const params = keyed ? buildKeyedParams(p) : p;

    try {
      return await opened.client.sendRequest(m, params, principal);
    } catch (error) {
      if (
        !this.closed.has(opened.client) ||
        !(keyed || PROCEDURE_TRAITS.get(m)?.readOnly === true)
      ) {
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

    let client: DaemonChannel;

    try {
      client = await this.openChannel(this.socketPath);
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
      hello = await client.sendHello(this.build, {
        session: readSessionEnv(process.env).sessionID,
      });
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
