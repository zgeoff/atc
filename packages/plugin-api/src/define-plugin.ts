import type { z } from 'zod';
import type { AgentAdapter } from './agent-adapter';
import type { AuthProfile } from './auth-profile';
import type { ExecutionProvider } from './execution-provider';
import type { HostServices } from './host-services';
import type { SourceProvider } from './types';

// The contract each kind of plugin creates.
interface PluginContracts {
  readonly harness: AgentAdapter;
  readonly execution: ExecutionProvider;
  readonly source: SourceProvider;
}

export type PluginKind = keyof PluginContracts;

export interface PluginContext {
  // every profile the whole config defines, which a slice selects by name.
  readonly authProfiles: ReadonlyMap<string, AuthProfile>;
}

export interface PluginConfigContext extends PluginContext {
  readonly entryID: string;

  // fields other plugins of the same kind own, which this entry may not set.
  readonly foreignFields: ReadonlySet<string>;
}

export interface PluginDefinition<K extends PluginKind, C> {
  readonly kind: K;
  readonly id: string;

  // fields beside the ones every entry of its kind takes.
  readonly configFields: readonly string[];

  // built for each entry from that entry's context.
  readonly configSchema: (context: PluginConfigContext) => z.ZodType<C>;
  readonly create: (config: C, host: HostServices, context: PluginContext) => PluginContracts[K];
}

export function definePlugin<K extends PluginKind, C>(
  definition: PluginDefinition<K, C>,
): PluginDefinition<K, C> {
  return definition;
}
