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

/**
 * What a plugin reads beside its own slice of config: the auth profiles
 * the whole config defines, which a slice selects from by name.
 */
export interface PluginContext {
  readonly authProfiles: ReadonlyMap<string, AuthProfile>;
}

/**
 * What parsing one config entry reads beside the entry: the plugin context,
 * the entry's id, and the fields that other plugins of the same kind own,
 * which an entry of this plugin may not set.
 */
export interface PluginConfigContext extends PluginContext {
  readonly entryID: string;
  readonly foreignFields: ReadonlySet<string>;
}

/**
 * One plugin: its kind, the id a config entry selects it by, the fields
 * its entries may set beside the ones every entry of its kind takes, the
 * schema of its config slice, built for each entry from that entry's
 * context, and the factory that creates its contract from a parsed slice,
 * the host's services, and the plugin context.
 */
export interface PluginDefinition<K extends PluginKind, C> {
  readonly kind: K;
  readonly id: string;
  readonly configFields: readonly string[];
  readonly configSchema: (context: PluginConfigContext) => z.ZodType<C>;
  readonly create: (config: C, host: HostServices, context: PluginContext) => PluginContracts[K];
}

/**
 * Checks a plugin's definition against its kind's contract and returns it
 * unchanged.
 */
export function definePlugin<K extends PluginKind, C>(
  definition: PluginDefinition<K, C>,
): PluginDefinition<K, C> {
  return definition;
}
