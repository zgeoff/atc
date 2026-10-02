import { createHash } from 'node:crypto';
import type { TargetConfigError } from '../shared/collect-targets';
import type { ExecutionTarget } from './build-execution-targets';

/**
 * A short digest of the target config a daemon runs with: each target's id
 * and identity, the default target, and the config errors. Two daemons with
 * the same targets return the same revision, and any change to them
 * changes it.
 */
export function buildConfigRevision(
  targets: readonly ExecutionTarget[],
  defaultTarget: string | null,
  errors: readonly TargetConfigError[],
): string {
  const canonical = JSON.stringify({
    targets: targets.map((target) => [target.id, target.identity]),
    defaultTarget,
    errors: errors.map((error) => [error.scope, error.target ?? null, error.problem]),
  });

  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
