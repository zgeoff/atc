import type { Clock } from '@atc/core';
import { createGatewayDaemonCaller } from './create-gateway-daemon-caller';
import type { GatewayDaemonCaller } from './create-gateway-daemon-caller';
import type { GatewayChannel, GatewayRegistry, RegistryDaemon } from './types';

interface DaemonPoolOptions {
  readonly registry: GatewayRegistry;
  readonly build: string;
  readonly openChannel: (address: RegistryDaemon['address']) => Promise<GatewayChannel>;
  readonly connectTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
  readonly clock?: Clock;
}

export interface DaemonPool {
  readonly getCaller: (name: string) => GatewayDaemonCaller;
  readonly stop: () => Promise<void>;
}

export function createDaemonPool(opts: DaemonPoolOptions): DaemonPool {
  const callers: ReadonlyMap<string, GatewayDaemonCaller> = new Map(
    [...opts.registry.daemons.values()].map((daemon) => [
      daemon.name,
      createGatewayDaemonCaller({
        daemon,
        build: opts.build,
        openChannel: opts.openChannel,
        ...(opts.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: opts.connectTimeoutMs }),
        ...(opts.responseTimeoutMs === undefined
          ? {}
          : { responseTimeoutMs: opts.responseTimeoutMs }),
        ...(opts.clock === undefined ? {} : { clock: opts.clock }),
      }),
    ]),
  );

  return {
    getCaller: (name) => {
      const caller = callers.get(name);

      if (caller === undefined) {
        throw new Error(`no daemon '${name}' in the registry`);
      }

      return caller;
    },

    stop: async () => {
      await Promise.all([...callers.values()].map((caller) => caller.stop()));
    },
  };
}
