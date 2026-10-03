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
