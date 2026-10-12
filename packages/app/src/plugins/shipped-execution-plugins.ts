import { IMP_PLUGIN } from '@atc/execution-imp/imp-plugin';
import { LOCAL_PTY_PLUGIN } from '@atc/execution-local/local-pty-plugin';
import type { PluginDefinition } from '@atc/plugin-api/define-plugin';
import type { ExecutionTargetConfig } from '@atc/plugin-api/execution-target-config';

/**
 * The execution plugins atc ships, each selected by a target's `provider`.
 */
export const SHIPPED_EXECUTION_PLUGINS: readonly PluginDefinition<
  'execution',
  ExecutionTargetConfig
>[] = [LOCAL_PTY_PLUGIN, IMP_PLUGIN];
