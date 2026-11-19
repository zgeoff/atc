import type { TargetIdentityRule } from '@atc/core';
import type { z } from 'zod';
import type { AgentAdapter } from '../agent-adapter';
import type { AuthProfile } from '../credentials/auth-profile';
import type { ExecutionProvider } from '../execution/execution-provider';
import type { SourceProvider } from '../types';
import type { ExecutionHostServices, HostServices } from './host-services';

// The contract each kind of plugin creates.
interface PluginContracts {
  readonly harness: AgentAdapter;
  readonly execution: ExecutionProvider;
  readonly source: SourceProvider;
}

export type PluginKind = keyof PluginContracts;

// The services each kind of plugin's create receives.
interface PluginHosts {
  readonly harness: HostServices;
  readonly execution: ExecutionHostServices;
  readonly source: HostServices;
}

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

  // How an execution target of this plugin names the host it binds to. It
  // sits on the definition, so a target whose provider fails to build still
  // has its identity. Absent writes the kind and a digest of every option.
  readonly identity?: TargetIdentityRule;
  readonly create: (config: C, host: PluginHosts[K], context: PluginContext) => PluginContracts[K];
}

export function definePlugin<K extends PluginKind, C>(
  definition: PluginDefinition<K, C>,
): PluginDefinition<K, C> {
  return definition;
}
