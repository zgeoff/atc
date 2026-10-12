import type { z } from 'zod';
import type { AgentAdapter } from './agent-adapter';
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
 * One plugin: its kind, the id a config entry selects it by, the schema of
 * its own slice of that entry, and the factory that creates its contract
 * from a parsed slice and the host's services.
 */
export interface PluginDefinition<K extends PluginKind, C> {
  readonly kind: K;
  readonly id: string;
  readonly configSchema: z.ZodType<C>;
  readonly create: (config: C, host: HostServices) => PluginContracts[K];
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
