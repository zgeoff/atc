import type { Config } from '@atc/config';
import { formatDaemonConfigProblems } from './format-daemon-config-problems';

type ConfigReloadPick =
  | { readonly kind: 'refuse'; readonly cause: string }
  | {
      readonly kind: 'apply';
      readonly keepDefaultTarget: boolean;
      readonly lines: readonly string[];
    };

export function pickConfigReload(config: Config): ConfigReloadPick {
  for (const error of config.targetErrors) {
    if (error.scope === 'config') {
      return {
        kind: 'refuse',
        cause: `${error.path} cannot be used: ${error.problem}, ${error.detail}`,
      };
    }
  }

  const defaultTargetErrors = config.targetErrors.filter(
    (error) => error.scope === 'defaultTarget',
  );

  return {
    kind: 'apply',
    keepDefaultTarget: defaultTargetErrors.length > 0,
    lines: formatDaemonConfigProblems(config, defaultTargetErrors, []),
  };
}
