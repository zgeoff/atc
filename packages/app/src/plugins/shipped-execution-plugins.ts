import { IMP_PLUGIN } from '@atc/execution-imp';
import { LOCAL_PTY_PLUGIN } from '@atc/execution-local';
import type { ExecutionTargetConfig, PluginDefinition } from '@atc/plugin-api';

export const SHIPPED_EXECUTION_PLUGINS: readonly PluginDefinition<
  'execution',
  ExecutionTargetConfig
>[] = [LOCAL_PTY_PLUGIN, IMP_PLUGIN];
