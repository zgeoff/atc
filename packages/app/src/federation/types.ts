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
    m: string,
    p?: Readonly<Record<string, unknown>>,
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
