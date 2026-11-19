import { LOCAL_TARGET } from '@atc/config';
import { buildTargetIdentity } from '@atc/store';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { buildTargetAccessFromGrants } from './build-target-access-from-grants';
import type { TargetAccess } from './build-target-access-from-grants';

export function buildTargetAccess(
  principals: ReadonlyMap<string, readonly string[]> | null,
  targets: ReadonlyMap<string, ExecutionTarget>,
  principal: string,
): TargetAccess {
  if (principals === null) {
    return buildTargetAccessFromGrants([
      {
        target: LOCAL_TARGET.id,
        targetIdentity: buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
      },
    ]);
  }

  const granted = principals.get(principal) ?? [];

  return buildTargetAccessFromGrants(
    granted.flatMap((id) => {
      const target = targets.get(id);

      return target === undefined ? [] : [{ target: id, targetIdentity: target.identity }];
    }),
  );
}
