import type { Config } from '@atc/config';
import type { DaemonHandle } from '@atc/daemon';
import type { AgentAdapter } from '@atc/plugin-api';
import { formatDaemonConfigProblems } from './format-daemon-config-problems';

interface ConfigReloadDeps {
  readonly handle: Pick<DaemonHandle, 'reloadConfig'>;
  readonly loadConfig: () => Config;
  readonly buildAdapters: (config: Config) => AgentAdapter[];
  readonly writeLine: (line: string) => void;
}

export function runConfigReload(deps: ConfigReloadDeps): void {
  try {
    const config = deps.loadConfig();

    for (const error of config.targetErrors) {
      if (error.scope === 'config') {
        throw new Error(`${error.path} cannot be used: ${error.problem}, ${error.detail}`);
      }
    }

    const adapters = deps.buildAdapters(config);

    for (const line of formatDaemonConfigProblems(config, [], [])) {
      deps.writeLine(line);
    }

    const problems = deps.handle.reloadConfig({
      adapters,
      defaultAgent: config.defaultAgent,
      defaultTarget: config.defaultTarget,
      hooks: config.hooks,
    });

    for (const problem of problems) {
      deps.writeLine(`atc daemon: config: ${problem}`);
    }
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);

    deps.writeLine(`atc daemon: config reload failed (${cause}); the daemon keeps its old config`);
  }
}
