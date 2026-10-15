import type { DaemonFeature } from '@atc/protocol';

/**
 * One daemon the gateway routes to: its logical name, the TCP address it
 * listens on, the state identity pinned behind the name, the incarnation
 * that identity puts in every gateway id, and the bearer token the gateway
 * presents to it.
 */
export interface RegistryDaemon {
  readonly name: string;
  readonly address: { readonly host: string; readonly port: number };
  readonly daemonID: string;

  // The first 8 hex digits of the pinned daemon ID.
  readonly incarnation: string;
  readonly token: string;
}

/**
 * The daemons the gateway routes to, by name, and the one a spawn without
 * a daemon goes to.
 */
export interface GatewayRegistry {
  readonly daemons: ReadonlyMap<string, RegistryDaemon>;
  readonly defaultDaemon: string;
}

/**
 * A feature the gateway announces to the tool layer: every feature an up
 * daemon announces, plus `fleet.daemons`, which marks a caller that routes
 * across named daemons and offers the tools and inputs that pick one.
 */
export type GatewayFeature = DaemonFeature | 'fleet.daemons';

/**
 * One open protocol connection to a daemon, as the caller drives it:
 * correlated requests, a callback for when the connection ends, and closing
 * it. A request that rejects after the callback fired got no response.
 */
export interface GatewayChannel {
  onClose: () => void;
  readonly sendRequest: (
    m: string,
    p?: Readonly<Record<string, unknown>>,
    as?: string,
    asName?: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly stop: () => void;
}

/**
 * What a daemon's handshake told the gateway: its build, its state
 * identity, the features it serves, and how long it keeps a completed
 * idempotency key, null when it announced none.
 */
export interface DaemonHello {
  readonly build: string;
  readonly daemonID: string;
  readonly features: ReadonlySet<DaemonFeature>;
  readonly retentionMs: number | null;
}

/**
 * Turns a request's params into the params one write of it sends, right
 * before that write.
 */
export type ParamsPreparer = (
  params: Readonly<Record<string, unknown>>,
) => Readonly<Record<string, unknown>>;
