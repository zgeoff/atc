import { DaemonCaller } from './daemon-caller';
import type { GatewayChannel } from './daemon-caller';
import type { GatewayRegistry, RegistryDaemon } from './types';

interface DaemonPoolOptions {
  readonly registry: GatewayRegistry;
  readonly build: string;
  readonly openChannel: (address: RegistryDaemon['address']) => Promise<GatewayChannel>;
  readonly connectTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
}

/**
 * One caller per registry daemon, each with its own connection, token, and
 * pin, so a call routed to one daemon never rides another's connection.
 */
export class DaemonPool {
  private readonly callers: ReadonlyMap<string, DaemonCaller>;

  constructor(opts: DaemonPoolOptions) {
    this.callers = new Map(
      [...opts.registry.daemons.values()].map((daemon) => [
        daemon.name,
        new DaemonCaller({
          daemon,
          build: opts.build,
          openChannel: opts.openChannel,
          ...(opts.connectTimeoutMs === undefined
            ? {}
            : { connectTimeoutMs: opts.connectTimeoutMs }),
          ...(opts.responseTimeoutMs === undefined
            ? {}
            : { responseTimeoutMs: opts.responseTimeoutMs }),
        }),
      ]),
    );
  }

  /**
   * The caller of a registry daemon. Throws for a name the registry does
   * not hold, which a route resolved through the registry never gives.
   */
  getCaller(name: string): DaemonCaller {
    const caller = this.callers.get(name);

    if (caller === undefined) {
      throw new Error(`no daemon '${name}' in the registry`);
    }

    return caller;
  }

  async stop(): Promise<void> {
    await Promise.all([...this.callers.values()].map((caller) => caller.stop()));
  }
}
