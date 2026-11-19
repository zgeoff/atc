import type { TargetAccess } from '../auth/build-target-access-from-grants';
import type { DaemonContext } from '../types';

// The targets a request may use and the namespace of its idempotency keys.
export interface RequestScope {
  readonly access: TargetAccess;
  readonly keyNamespace: string;
}

// Null is the daemon's owner. A connection that acts as a principal always keeps its own
// idempotency keys, whatever principal a request acts as.
export function findRequestScope(
  ctx: DaemonContext,
  principal: string | null,
  connectionAccess: TargetAccess | null,
  as: string | undefined,
): RequestScope | null {
  if (as === undefined) {
    return principal === null || connectionAccess === null
      ? null
      : { access: connectionAccess, keyNamespace: `client:${principal}` };
  }

  const access = ctx.buildTargetAccess(as);

  if (principal === null || connectionAccess === null) {
    return { access, keyNamespace: `client:${as}` };
  }

  return {
    access: connectionAccess.merge(access),
    keyNamespace: `client:${principal}`,
  };
}
