import type { Config } from '@atc/config';
import type { DaemonHandle } from '@atc/daemon';
import type { AgentAdapter } from '@atc/plugin-api';
import { pickConfigReload } from './pick-config-reload';

interface ConfigReloadDeps {
  readonly handle: Pick<DaemonHandle, 'reloadConfig'>;
  readonly loadConfig: () => Config;
  readonly buildAdapters: (config: Config) => AgentAdapter[];
  readonly writeLine: (line: string) => void;
}

export function runConfigReload(deps: ConfigReloadDeps): void {
  try {
    const config = deps.loadConfig();
    const pick = pickConfigReload(config);

    if (pick.kind === 'refuse') {
      deps.writeLine(
        `atc daemon: config reload failed (${pick.cause}); the daemon keeps its old config`,
      );

      return;
    }

    const adapters = deps.buildAdapters(config);

    for (const line of pick.lines) {
      deps.writeLine(line);
    }

    const problems = deps.handle.reloadConfig({
      adapters,
      defaultAgent: config.defaultAgent,
      ...(pick.keepDefaultTarget ? {} : { defaultTarget: config.defaultTarget }),
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
