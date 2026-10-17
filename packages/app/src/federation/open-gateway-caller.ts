import type { Clock } from '@atc/core';
import { DaemonPool } from './daemon-pool';
import { GatewayStore } from './gateway-store';
import { RoutingCaller } from './routing-caller';
import type { GatewayChannel, GatewayRegistry, RegistryDaemon } from './types';

interface GatewayCallerOptions {
  readonly registry: GatewayRegistry;
  readonly build: string;

  // Connects to a daemon's TCP address.
  readonly openChannel: (address: RegistryDaemon['address']) => Promise<GatewayChannel>;

  // The keyed-request bindings.
  readonly gatewayDBPath: string;

  // How long each daemon may take to answer a call asked of every daemon.
  readonly fanOutTimeoutMs?: number;

  // Runs each daemon connection's connect and response timers and the
  // fan-out waits, and reads the time for the binding store; the system
  // clock when unset.
  readonly clock?: Clock;
}

export function openGatewayCaller(opts: GatewayCallerOptions): {
  readonly caller: RoutingCaller;
  readonly stop: () => Promise<void>;
} {
  const store = GatewayStore.open(opts.gatewayDBPath);

  const pool = new DaemonPool({
    registry: opts.registry,
    build: opts.build,
    openChannel: opts.openChannel,
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
  });

  const caller = new RoutingCaller({
    registry: opts.registry,
    pool,
    store,
    ...(opts.fanOutTimeoutMs === undefined ? {} : { fanOutTimeoutMs: opts.fanOutTimeoutMs }),
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
  });

  return {
    caller,
    stop: async () => {
      await pool.stop();

      store.stop();
    },
  };
}
