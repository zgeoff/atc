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
      'docker',
      async () => {
        const docker = await import('@atc/execution-docker');

        return docker.DOCKER_PLUGIN;
      },
    ],
    [
      'sprites',
      async () => {
        const sprites = await import('@atc/execution-sprites');

        return sprites.SPRITES_PLUGIN;
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
