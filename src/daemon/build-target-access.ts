import type { ExecutionTarget } from './build-execution-targets';
import { buildTargetIdentity } from './build-target-identity';
import { TargetAccess } from './target-access';

/**
 * The targets a principal may use. With no principals in the config, every
 * principal gets the implicit `local` target alone: the name `local` with
 * the identity of a `local-pty` target without options, so a `local` that
 * now holds another provider or other options is outside it. With
 * principals, a principal gets each target its entry lists that the config
 * holds, at that target's identity now, and an unknown principal gets none.
 */
export function buildTargetAccess(
  principals: ReadonlyMap<string, readonly string[]> | null,
  targets: ReadonlyMap<string, ExecutionTarget>,
  principal: string,
): TargetAccess {
  if (principals === null) {
    return new TargetAccess([
      { target: 'local', targetIdentity: buildTargetIdentity('local-pty', {}) },
    ]);
  }

  const granted = principals.get(principal) ?? [];

  return new TargetAccess(
    granted.flatMap((id) => {
      const target = targets.get(id);

      return target === undefined ? [] : [{ target: id, targetIdentity: target.identity }];
    }),
  );
}
