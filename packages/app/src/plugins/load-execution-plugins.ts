import type { TargetConfig } from '@atc/config';
import type { ExecutionPlugin } from './shipped-execution-plugins';
import { SHIPPED_EXECUTION_PLUGINS } from './shipped-execution-plugins';

export function loadExecutionPlugins(targets: readonly TargetConfig[]): Promise<ExecutionPlugin[]> {
  const named = new Set(targets.map((target) => target.provider));

  return Promise.all(
    [...SHIPPED_EXECUTION_PLUGINS]
      .filter(([id]) => named.has(id))
      .map(([, loadPlugin]) => loadPlugin()),
  );
}
