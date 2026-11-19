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

  // Resolves once the caller can reach a daemon, and rejects when it cannot.
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

  // The shape of the tool's structured result, for the tools that declare one.
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations: MCPToolAnnotations;

  // what the caller must announce for the tool to be listed and each input
  // offered. `outputUnless` drops the output schema when the caller announces
  // that feature.
  readonly requires?: {
    readonly tool?: FleetFeature;
    readonly outputUnless?: FleetFeature;
    readonly inputs?: Readonly<Record<string, FleetFeature>>;
  };
  readonly scope: GrantScope;
}
