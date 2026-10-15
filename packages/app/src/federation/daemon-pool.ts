import type { Clock } from '@atc/core';
import { GatewayDaemonCaller } from './gateway-daemon-caller';
import type { GatewayChannel, GatewayRegistry, RegistryDaemon } from './types';

interface DaemonPoolOptions {
  readonly registry: GatewayRegistry;
  readonly build: string;
  readonly openChannel: (address: RegistryDaemon['address']) => Promise<GatewayChannel>;
  readonly connectTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
  readonly clock?: Clock;
}

/**
 * One caller per registry daemon, each with its own connection, token, and
 * pin, so a call routed to one daemon never rides another's connection.
 */
export class DaemonPool {
  private readonly callers: ReadonlyMap<string, GatewayDaemonCaller>;

  constructor(opts: DaemonPoolOptions) {
    this.callers = new Map(
      [...opts.registry.daemons.values()].map((daemon) => [
        daemon.name,
        new GatewayDaemonCaller({
          daemon,
          build: opts.build,
          openChannel: opts.openChannel,
          ...(opts.connectTimeoutMs === undefined
            ? {}
            : { connectTimeoutMs: opts.connectTimeoutMs }),
          ...(opts.responseTimeoutMs === undefined
            ? {}
            : { responseTimeoutMs: opts.responseTimeoutMs }),
          ...(opts.clock === undefined ? {} : { clock: opts.clock }),
        }),
      ]),
    );
  }

  /**
   * The caller of a registry daemon. Throws for a name the registry does
   * not hold, which a route resolved through the registry never gives.
   */
  getCaller(name: string): GatewayDaemonCaller {
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
