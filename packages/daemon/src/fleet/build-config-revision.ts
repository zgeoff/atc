import { createHash } from 'node:crypto';
import type { TargetConfigError } from '@atc/config';
import type { ExecutionTarget } from './build-execution-targets';

export function buildConfigRevision(
  targets: readonly ExecutionTarget[],
  defaultTarget: string | null,
  errors: readonly TargetConfigError[],
): string {
  const canonical = JSON.stringify({
    targets: targets.map((target) => [target.id, target.identity]),
    defaultTarget,
    errors: errors.map((error) =>
      error.scope === 'config'
        ? [error.scope, error.path, error.problem, error.detail]
        : [error.scope, error.target ?? null, error.problem],
    ),
  });

  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
