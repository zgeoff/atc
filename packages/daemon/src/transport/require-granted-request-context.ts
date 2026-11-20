import { AtcError } from '@atcx/contract/light';
import { buildGrantedContext } from '../auth/build-granted-context';
import { buildScopedContext } from '../auth/build-scoped-context';
import { buildTargetAccessFromGrants } from '../auth/build-target-access-from-grants';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import { GRANTED_METHOD_SCOPES } from '../auth/granted-method-scopes';
import type { DaemonContext } from '../types';
import type { RequestPrincipal } from './request-deps';
import type { BridgeGrant } from './types';

export interface GrantedRequestSource {
  readonly ctx: DaemonContext;
  readonly connectionAccess: TargetAccess | null;
  readonly bridge: BridgeGrant;
}

export function requireGrantedRequestContext(
  source: GrantedRequestSource,
  method: string,
  as: RequestPrincipal | null,
): DaemonContext {
  if (as !== null) {
    throw new AtcError('unauthorized', "a session's atc access acts as no principal");
  }

  if (!source.bridge.isCurrent()) {
    throw new AtcError(
      'unauthorized',
      `session '${source.bridge.holder}' started or moved again since this connection opened`,
    );
  }

  const held = source.ctx.findHeldAtcAccess(source.bridge.holder);

  if (held === null) {
    throw new AtcError('unauthorized', `session '${source.bridge.holder}' holds no atc access`);
  }

  const needed = GRANTED_METHOD_SCOPES[method];

  if (needed === undefined) {
    throw new AtcError('unauthorized', `${method} is closed to a session's atc access`);
  }

  if (needed !== 'any' && !held.scopes.includes(needed)) {
    throw new AtcError(
      'unauthorized',
      `${method} needs atc scope ${needed}, which session '${source.bridge.holder}' does not hold`,
      { scope: needed },
    );
  }

  if (method === 'events.subscribe') {
    return buildScopedContext(
      source.ctx,
      source.connectionAccess ?? buildTargetAccessFromGrants([]),
      `session:${source.bridge.holder}`,
    );
  }

  return buildGrantedContext(source.ctx, source.bridge.holder, held, method);
}
