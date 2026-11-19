import { collectTargets } from '@atc/config';
import type { ExecutionProvider } from '@atc/plugin-api';
import { buildTargetIdentity } from '@atc/store';
import type { DaemonOptions } from '../types';

interface RawTargetConfig {
  readonly targets?: unknown;

  readonly defaultTarget?: unknown;
}

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
