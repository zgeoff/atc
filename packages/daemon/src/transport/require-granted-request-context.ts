import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import { buildGrantedContext } from '../auth/build-granted-context';
import { buildScopedContext } from '../auth/build-scoped-context';
import { buildTargetAccessFromGrants } from '../auth/build-target-access-from-grants';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import { GRANTED_METHOD_SCOPES } from '../auth/granted-method-scopes';
import type { DaemonContext } from '../types';
import type { RequestPrincipal } from './request-deps';

// A connection through a session's bridge socket.
export interface BridgeGrant {
  readonly holder: SessionID;
  readonly isCurrent: () => boolean;
}

// What a bridge connection's request is checked against.
export interface GrantedRequestSource {
  readonly ctx: DaemonContext;
  readonly connectionAccess: TargetAccess | null;
  readonly bridge: BridgeGrant;
}

// The context a request through a session's bridge runs on: the scope its
// method needs must be one the session holds now, under a binding that
// still matches the live session; a refusal throws.
export function requireGrantedRequestContext(
  source: GrantedRequestSource,
  method: string,
  as: RequestPrincipal | null,
): DaemonContext {
  if (as !== null) {
    throw new DaemonError('unauthorized', "a session's atc access acts as no principal");
  }

  if (!source.bridge.isCurrent()) {
    throw new DaemonError(
      'unauthorized',
      `session '${source.bridge.holder}' started or moved again since this connection opened`,
    );
  }

  const held = source.ctx.findHeldAtcAccess(source.bridge.holder);

  if (held === null) {
    throw new DaemonError('unauthorized', `session '${source.bridge.holder}' holds no atc access`);
  }

  const needed = GRANTED_METHOD_SCOPES[method];

  if (needed === undefined) {
    throw new DaemonError('unauthorized', `${method} is closed to a session's atc access`);
  }

  if (needed !== 'any' && !held.scopes.includes(needed)) {
    throw new DaemonError(
      'unauthorized',
      `${method} needs atc scope ${needed}, which session '${source.bridge.holder}' does not hold`,
      { scope: needed },
    );
  }

  // A subscription delivers only what the connection's own view admits.
  if (method === 'events.subscribe') {
    return buildScopedContext(
      source.ctx,
      source.connectionAccess ?? buildTargetAccessFromGrants([]),
      `session:${source.bridge.holder}`,
    );
  }

  return buildGrantedContext(source.ctx, source.bridge.holder, held, method);
}
