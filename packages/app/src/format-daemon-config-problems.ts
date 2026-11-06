import type { Config, TargetConfigError } from '@atc/config';

export function formatDaemonConfigProblems(
  config: Config,
  targetErrors: readonly TargetConfigError[],
  sourceProblems: readonly string[],
): string[] {
  const lines = targetErrors.map((error) =>
    error.scope === 'config'
      ? `${error.path} cannot be used (${error.problem}: ${error.detail}); every spawn is refused, local ones included, until it is fixed`
      : error.problem,
  );

  lines.push(
    ...config.principalErrors,
    ...config.workspaceErrors,
    ...config.authProfileErrors,
    ...config.agentErrors,
    ...config.sourceErrors,
    ...config.deprecations,
  );

  if (config.removedKeys.length > 0) {
    lines.push(
      `config.json sets ${config.removedKeys.join(', ')}, which atc no longer reads; run 'atc config migrate' to drop it`,
    );
  }

  lines.push(...sourceProblems);

  return lines.map((line) => `atc daemon: config: ${line}`);
}
