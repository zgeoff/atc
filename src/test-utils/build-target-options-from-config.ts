import { buildTargetIdentity } from '../daemon/build-target-identity';
import type { DaemonOptions } from '../daemon/daemon';
import type { ExecutionProvider } from '../daemon/execution-provider';
import { collectTargets } from '../shared/collect-targets';

interface RawTargetConfig {
  // The raw `targets` key of a config file.
  readonly targets?: unknown;

  // The raw `defaultTarget` key of a config file.
  readonly defaultTarget?: unknown;
}

/**
 * Turns the raw target keys of a config file into daemon options through
 * the real parse. Each parsed target takes the provider that the factory
 * for its kind builds for its id, or no provider when no factory serves its
 * kind, and every parse error passes through as a target config error.
 */
export function buildTargetOptionsFromConfig(
  raw: RawTargetConfig,
  factories: ReadonlyMap<string, (id: string) => ExecutionProvider>,
): Required<Pick<DaemonOptions, 'targets' | 'defaultTarget' | 'targetErrors'>> {
  const parsed = collectTargets(raw.targets, raw.defaultTarget);

  return {
    targets: parsed.targets.map((target) => ({
      id: target.id,
      kind: target.provider,
      options: target.options,
      identity: buildTargetIdentity(target.provider, target.options),
      provider: factories.get(target.provider)?.(target.id) ?? null,
    })),
    defaultTarget: parsed.defaultTarget,
    targetErrors: parsed.errors,
  };
}
