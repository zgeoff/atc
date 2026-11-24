import type { Principal } from '@atc/protocol';
import type { GrantScope } from '@atcx/contract';

// `fleet.daemons` is announced only by a caller that routes across named daemons.
export type FleetFeature = 'fleet.daemons';

export interface FleetCaller {
  readonly sendRequest: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    principal?: Principal,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly features: ReadonlySet<FleetFeature>;

  readonly waitForDaemon: () => Promise<void>;
}

export interface FleetContext {
  // null acts as the daemon's owner: the stdio server alone passes it
  readonly principal: Principal | null;

  // the bearer's scopes; the stdio server passes all four
  readonly scopes: readonly GrantScope[];
}
