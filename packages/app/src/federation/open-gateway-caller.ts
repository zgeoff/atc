import type { GatewayChannel, TimeoutScheduler } from './daemon-caller';
import { DaemonPool } from './daemon-pool';
import { GatewayStore } from './gateway-store';
import { RoutingCaller } from './routing-caller';
import type { GatewayRegistry, RegistryDaemon } from './types';

interface GatewayCallerOptions {
  readonly registry: GatewayRegistry;
  readonly build: string;

  // Connects to a daemon's TCP address.
  readonly openChannel: (address: RegistryDaemon['address']) => Promise<GatewayChannel>;

  // The keyed-request bindings.
  readonly gatewayDBPath: string;

  // How long each daemon may take to answer a call asked of every daemon.
  readonly fanOutTimeoutMs?: number;

  // Starts each daemon connection's connect and response timers; real
  // timers when unset.
  readonly scheduleTimeout?: TimeoutScheduler;
}

/**
 * The caller the gateway's MCP tools ride: one pooled connection per
 * registry daemon, the binding store, and the router over them, which the
 * entrypoint hands to the MCP HTTP server. Nothing dials a daemon until a
 * call needs it, so a daemon that is down never holds up the start. `stop`
 * closes every daemon connection and the store.
 */
export function openGatewayCaller(opts: GatewayCallerOptions): {
  readonly caller: RoutingCaller;
  readonly stop: () => Promise<void>;
} {
  const store = GatewayStore.open(opts.gatewayDBPath);

  const pool = new DaemonPool({
    registry: opts.registry,
    build: opts.build,
    openChannel: opts.openChannel,
    ...(opts.scheduleTimeout === undefined ? {} : { scheduleTimeout: opts.scheduleTimeout }),
  });

  const caller = new RoutingCaller({
    registry: opts.registry,
    pool,
    store,
    ...(opts.fanOutTimeoutMs === undefined ? {} : { fanOutTimeoutMs: opts.fanOutTimeoutMs }),
  });

  return {
    caller,
    stop: async () => {
      await pool.stop();

      store.stop();
    },
  };
}
