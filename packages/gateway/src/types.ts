import type { Principal } from '@atc/protocol';
import type { DaemonError } from '@atc/protocol/wire';

export interface RegistryDaemon {
  readonly name: string;
  readonly address: { readonly host: string; readonly port: number };
  readonly daemonID: string;

  readonly incarnation: string;
  readonly token: string;
}

export interface GatewayRegistry {
  readonly daemons: ReadonlyMap<string, RegistryDaemon>;
  readonly defaultDaemon: string;
}

export type GatewayFeature = 'fleet.daemons';

export interface GatewayChannel {
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

export interface RoutedCall {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly principal: Principal;

  readonly named: RegistryDaemon | null;
  readonly owner: RegistryDaemon | null;

  readonly daemon: RegistryDaemon | null;

  readonly prepareParams?: ParamsPreparer;
}

export type RoutedOutcome =
  | {
      readonly kind: 'answered';
      readonly daemon: RegistryDaemon;
      readonly value: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'refused'; readonly daemon: RegistryDaemon; readonly error: DaemonError };

export type RouteNext = (call: RoutedCall) => Promise<RoutedOutcome>;
