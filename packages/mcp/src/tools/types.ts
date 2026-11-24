import type { FleetFeature } from '@atc/fleet-api';
import type { GrantScope } from '@atcx/contract';

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
