import type { Principal } from '@atc/protocol';
import type { GrantScope } from '@atcx/contract';
import type { ContractRouter, Meta, Router } from '@orpc/server';

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

export type FleetProcedure = (
  input: Readonly<Record<string, unknown>>,
) => Promise<Readonly<Record<string, unknown>>>;

// The procedures an MCP tool calls, by the daemon's method names, typed by what a tool sends and
// reads: the tool builds its input by hand, and the router checks it against the contract.
export interface FleetClient {
  readonly agents: { readonly list: FleetProcedure };
  readonly dirs: { readonly list: FleetProcedure };

  // the gateway's contract alone holds it
  readonly daemons?: { readonly list: FleetProcedure };
  readonly session: {
    readonly list: FleetProcedure;
    readonly get: FleetProcedure;
    readonly spawn: FleetProcedure;
    readonly update: FleetProcedure;
    readonly ack: FleetProcedure;
    readonly kill: FleetProcedure;
    readonly forget: FleetProcedure;
    readonly adopt: FleetProcedure;
    readonly submit: FleetProcedure;
    readonly screen: FleetProcedure;
    readonly menu: FleetProcedure;
    readonly choose: FleetProcedure;
    readonly read: FleetProcedure;
    readonly message: FleetProcedure;
    readonly scope: { readonly add: FleetProcedure };
    readonly auth: { readonly rebind: FleetProcedure };
  };
  readonly message: { readonly get: FleetProcedure };
  readonly note: { readonly get: FleetProcedure };
  readonly answer: { readonly get: FleetProcedure };
  readonly events: { readonly read: FleetProcedure };
}

// A router of either fleet contract.
export type FleetRouter = Router<ContractRouter<Meta>, FleetContext>;
