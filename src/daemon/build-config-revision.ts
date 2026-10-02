import { createHash } from 'node:crypto';
import type { ExecutionTarget } from './build-execution-targets';

/**
 * A short digest of the target config a daemon runs with: each target's id,
 * provider kind, and options, and the default target. Two daemons with the
 * same targets return the same revision, and any change to them changes it.
 */
export function buildConfigRevision(
  targets: readonly ExecutionTarget[],
  defaultTarget: string,
): string {
  const canonical = JSON.stringify({
    targets: targets.map((target) => [target.id, target.kind, sortKeys(target.options)]),
    defaultTarget,
  });

  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// Key order in a config file carries no meaning, so it never changes the
// digest.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeys(item));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }

  return value;
}
