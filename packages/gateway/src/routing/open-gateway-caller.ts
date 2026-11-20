import type { Clock } from '@atc/core';
import { createDaemonPool } from '../daemons/create-daemon-pool';
import { createGatewayStore } from '../key-binding/create-gateway-store';
import type { BindingDatabase } from '../key-binding/create-gateway-store';
import type { GatewayChannel, GatewayRegistry, RegistryDaemon } from '../types';
import { createRoutingCaller } from './create-routing-caller';
import type { RoutingCaller } from './create-routing-caller';

interface GatewayCallerOptions {
  readonly registry: GatewayRegistry;
  readonly build: string;

  readonly openChannel: (
    address: RegistryDaemon['address'],
  ) => GatewayChannel | Promise<GatewayChannel>;

  readonly bindings: BindingDatabase;

  readonly fanOutTimeoutMs?: number;

  readonly clock?: Clock;

  readonly onWarning: (message: string) => void;
}

export function openGatewayCaller(opts: GatewayCallerOptions): {
  readonly caller: RoutingCaller;
  readonly stop: () => Promise<void>;
} {
  const store = createGatewayStore(opts.bindings);

  const pool = createDaemonPool({
    registry: opts.registry,
    build: opts.build,
    openChannel: opts.openChannel,
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
    onWarning: opts.onWarning,
  });

  const caller = createRoutingCaller({
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
