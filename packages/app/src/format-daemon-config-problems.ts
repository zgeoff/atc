import type { Config, TargetConfigError } from '@atc/config';

export function formatDaemonConfigProblems(
  config: Config,
  targetErrors: readonly TargetConfigError[],
  missingSources: readonly string[],
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
    ...config.deprecations,
  );

  if (config.removedKeys.length > 0) {
    lines.push(
      `config.json sets ${config.removedKeys.join(', ')}, which atc no longer reads; run 'atc config migrate' to drop it`,
    );
  }

  lines.push(
    ...missingSources.map(
      (id) =>
        `workspaces.sources holds '${id}', which this daemon cannot offer; the picker leaves it out`,
    ),
  );

  return lines.map((line) => `atc daemon: config: ${line}`);
}
