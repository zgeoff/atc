import type { ExecutionTargetConfig, PluginDefinition } from '@atc/plugin-api';

export type ExecutionPlugin = PluginDefinition<'execution', ExecutionTargetConfig>;

// Each provider's modules load only for a config that names it, so a daemon
// with no imp target never loads the imp client.
export const SHIPPED_EXECUTION_PLUGINS: ReadonlyMap<string, () => Promise<ExecutionPlugin>> =
  new Map([
    [
      'local-pty',
      async () => {
        const local = await import('@atc/execution-local');

        return local.LOCAL_PTY_PLUGIN;
      },
    ],
    [
      'imp',
      async () => {
        const imp = await import('@atc/execution-imp');

        return imp.IMP_PLUGIN;
      },
    ],
  ]);
