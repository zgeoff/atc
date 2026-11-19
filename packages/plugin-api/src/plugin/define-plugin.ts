import type { TargetIdentityRule } from '@atc/core';
import type { z } from 'zod';
import type { AgentAdapter } from '../agent-adapter';
import type { AuthProfile } from '../credentials/auth-profile';
import type { ExecutionProvider } from '../execution/execution-provider';
import type { SourceProvider } from '../types';
import type { ExecutionHostServices, HostServices } from './host-services';

interface PluginContracts {
  readonly harness: AgentAdapter;
  readonly execution: ExecutionProvider;
  readonly source: SourceProvider;
}

export type PluginKind = keyof PluginContracts;

interface PluginHosts {
  readonly harness: HostServices;
  readonly execution: ExecutionHostServices;
  readonly source: HostServices;
}

export interface PluginContext {
  readonly authProfiles: ReadonlyMap<string, AuthProfile>;
}

export interface PluginConfigContext extends PluginContext {
  readonly entryID: string;

  readonly foreignFields: ReadonlySet<string>;
}

export interface PluginDefinition<K extends PluginKind, C> {
  readonly kind: K;
  readonly id: string;

  readonly configFields: readonly string[];

  readonly configSchema: (context: PluginConfigContext) => z.ZodType<C>;

  readonly identity?: TargetIdentityRule;
  readonly create: (config: C, host: PluginHosts[K], context: PluginContext) => PluginContracts[K];
}

export function definePlugin<K extends PluginKind, C>(
  definition: PluginDefinition<K, C>,
): PluginDefinition<K, C> {
  return definition;
}
