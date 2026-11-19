import type { TargetConfig, TargetConfigError } from '@atc/config';
import type { TargetIdentityRule } from '@atc/core';
import type { ExecutionProvider } from '@atc/plugin-api';
import { buildTargetIdentity } from '@atc/store';

export interface ExecutionTarget {
  readonly id: string;
  readonly kind: string;
  readonly options: Readonly<Record<string, unknown>>;

  readonly identity: string;

  readonly identityRule?: TargetIdentityRule;

  readonly provider: ExecutionProvider | null;
}

export interface ProviderBuild {
  readonly provider: ExecutionProvider | null;
  readonly problem: string | null;

  // The plugin defines this rule, so it is known even when the provider fails to build.
  readonly identityRule?: TargetIdentityRule | undefined;
}

interface ExecutionTargetsBuild {
  readonly targets: ExecutionTarget[];
  readonly errors: TargetConfigError[];
}

export function buildExecutionTargets(
  configs: readonly TargetConfig[],
  buildProvider: (config: TargetConfig) => ProviderBuild,
): ExecutionTargetsBuild {
  const errors: TargetConfigError[] = [];

  const targets = configs.map((config) => {
    const built = buildProvider(config);

    if (built.problem !== null) {
      errors.push({ scope: 'target', target: config.id, problem: built.problem });
    }

    return {
      id: config.id,
      kind: config.provider,
      options: config.options,
      identity: buildTargetIdentity(config.provider, config.options, built.identityRule),
      ...(built.identityRule === undefined ? {} : { identityRule: built.identityRule }),
      provider: built.provider,
    };
  });

  return { targets, errors };
}
