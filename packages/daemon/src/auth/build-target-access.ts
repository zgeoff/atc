import { LOCAL_TARGET } from '@atc/config';
import { buildTargetIdentity } from '@atc/store';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { TargetAccess } from './target-access';

export function buildTargetAccess(
  principals: ReadonlyMap<string, readonly string[]> | null,
  targets: ReadonlyMap<string, ExecutionTarget>,
  principal: string,
): TargetAccess {
  // the implicit grant pins the identity of a `local-pty` target without
  // options, so a `local` configured with another provider or options is out
  if (principals === null) {
    return new TargetAccess([
      {
        target: LOCAL_TARGET.id,
        targetIdentity: buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
      },
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
