import type { Principal } from '@atc/protocol';

// `fleet.daemons` is announced only by a caller that routes across named daemons.
export type FleetFeature = 'fleet.daemons';

export interface FleetCaller {
  readonly sendRequest: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    principal?: Principal,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly features: ReadonlySet<FleetFeature>;

  // Resolves once the caller can reach a daemon, and rejects when it cannot.
  readonly waitForDaemon: () => Promise<void>;
}

export interface ToolContext {
  readonly callerSessionID: string | null;
}
