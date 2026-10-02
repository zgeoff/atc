import { DaemonClient } from '../client/daemon-client';
import type { FleetCaller } from './types';

/**
 * A daemon caller that survives a daemon restart: once the connection ends,
 * the next request opens and handshakes a fresh one. A request that was in
 * flight when the connection ended fails and is never retried, because a
 * grant refresh or a spawn must not run twice.
 */
export class ReconnectingCaller implements FleetCaller {
  private readonly socketPath: string;

  private readonly build: string;

  private client: Promise<DaemonClient> | null = null;

  constructor(socketPath: string, build: string) {
    this.socketPath = socketPath;
    this.build = build;
  }

  async sendRequest(
    m: string,
    p?: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const client = await this.openClient();

    return client.sendRequest(m, p);
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
    this.client ??= this.openFreshClient();

    return this.client;
  }

  private async openFreshClient(): Promise<DaemonClient> {
    try {
      const client = await DaemonClient.open(this.socketPath);

      client.onClose = () => {
        this.client = null;
      };

      await client.sendHello(this.build);

      return client;
    } catch (error) {
      this.client = null;
      throw error;
    }
  }
}
