import { DaemonClient } from '../client/daemon-client';
import type { FleetCaller } from './types';

// The daemon requests the read-only tools send. Each only reads, so running
// one twice is harmless.
const RETRYABLE_METHODS: ReadonlySet<string> = new Set([
  'dirs.list',
  'events.read',
  'message.get',
  'session.get',
  'session.list',
  'session.read',
  'session.resumeCommand',
  'session.screen',
]);

/**
 * A daemon caller that survives a daemon restart: once the connection ends,
 * the next request opens and handshakes a fresh one. A request that was in
 * flight when the connection ended is retried once on a fresh connection only
 * when it is read-only; any other fails, because a spawn or a message must not
 * run twice.
 */
export class ReconnectingCaller implements FleetCaller {
  private readonly socketPath: string;

  private readonly build: string;

  private client: Promise<DaemonClient> | null = null;

  private readonly closed = new WeakSet<DaemonClient>();

  constructor(socketPath: string, build: string) {
    this.socketPath = socketPath;
    this.build = build;
  }

  async sendRequest(
    m: string,
    p?: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const client = await this.openClient();

    try {
      return await client.sendRequest(m, p);
    } catch (error) {
      if (!this.closed.has(client) || !RETRYABLE_METHODS.has(m)) {
        throw error;
      }

      const fresh = await this.openClient();

      return fresh.sendRequest(m, p);
    }
  }

  async stop(): Promise<void> {
    const current = this.client;

    this.client = null;

    if (current === null) {
      return;
    }

    try {
      const client = await current;

      client.stop();
    } catch {
      // A connection that never opened has nothing to close.
    }
  }

  private openClient(): Promise<DaemonClient> {
    if (this.client === null) {
      const opening: Promise<DaemonClient> = this.openFreshClient(() => this.client === opening);

      this.client = opening;
    }

    return this.client;
  }

  // isCurrent returns true while this connection is still the one later requests
  // reuse: a connection that ends after a newer one replaced it must leave
  // the newer one in place.
  private async openFreshClient(isCurrent: () => boolean): Promise<DaemonClient> {
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

    try {
      await client.sendHello(this.build);
    } catch (error) {
      client.stop();

      resetClient();
      throw error;
    }

    return client;
  }
}
