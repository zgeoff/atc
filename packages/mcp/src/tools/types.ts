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

export interface ToolContext {
  readonly callerSessionID: string | null;
}

export interface MCPToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly openWorldHint: boolean;
}

export interface MCPToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;

  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations: MCPToolAnnotations;

  readonly requires?: {
    readonly tool?: FleetFeature;
    readonly outputUnless?: FleetFeature;
    readonly inputs?: Readonly<Record<string, FleetFeature>>;
  };
  readonly scope: GrantScope;
}
