import type { ContractRouterClient } from '@orpc/contract';
import type { FLEET_CONTRACT } from './fleet-contract';

// The gateway's fleet procedures as a program calls them, typed by FLEET_CONTRACT. The oRPC bound
// on a client context is a record of any.
// oxlint-disable-next-line typescript/no-explicit-any -- oRPC's own bound for a client context is a record of any
export type FleetProcedures<TContext extends Record<PropertyKey, any> = Record<string, never>> =
  ContractRouterClient<typeof FLEET_CONTRACT, TContext>;
