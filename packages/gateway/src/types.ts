import type { Principal } from '@atc/protocol';
import type { DaemonError } from '@atc/protocol/wire';

export interface RegistryDaemon {
  readonly name: string;
  readonly address: { readonly host: string; readonly port: number };
  readonly daemonID: string;

  // The first 8 hex digits of the pinned daemon ID.
  readonly incarnation: string;
  readonly token: string;
}

export interface GatewayRegistry {
  readonly daemons: ReadonlyMap<string, RegistryDaemon>;
  readonly defaultDaemon: string;
}

// `fleet.daemons` marks a caller that routes across named daemons and offers the inputs
// that pick one
export type GatewayFeature = 'fleet.daemons';

export interface GatewayChannel {
  // a request that rejects after this fired got no response
  onClose: () => void;
  readonly sendRequest: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    as?: string,
    asName?: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly stop: () => void;
}

export interface DaemonHello {
  readonly build: string;
  readonly daemonID: string;
  readonly retentionMs: number | null;
}

export type ParamsPreparer = (
  params: Readonly<Record<string, unknown>>,
) => Readonly<Record<string, unknown>>;

// One call on its way through the routing steps to a daemon. Each step
// takes the call and the steps after it, and hands on a changed call.
export interface RoutedCall {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly principal: Principal;

  // The daemon the call's `daemon` param names, and the one its ids belong
  // to; each is null when the call gives none.
  readonly named: RegistryDaemon | null;
  readonly owner: RegistryDaemon | null;

  // The daemon the call goes to, null until a step picks it.
  readonly daemon: RegistryDaemon | null;

  // Picks the params of each write of the request, right before it.
  readonly prepareParams?: ParamsPreparer;
}

// What a daemon gave a routed call: its answer, or its refusal.
export type RoutedOutcome =
  | {
      readonly kind: 'answered';
      readonly daemon: RegistryDaemon;
      readonly value: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'refused'; readonly daemon: RegistryDaemon; readonly error: DaemonError };

export type RouteNext = (call: RoutedCall) => Promise<RoutedOutcome>;
