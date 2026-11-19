import { DaemonError } from '@atc/protocol/wire';
import { buildScopedContext } from '../auth/build-scoped-context';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import { isOwnerOnlyMethod } from '../auth/is-owner-only-method';
import type { DaemonContext } from '../types';
import { findRequestScope } from './find-request-scope';
import type { RequestPrincipal } from './request-deps';
import type { TCPPeer } from './tcp-peer';

// What a TCP connection's request is checked against.
export interface TCPRequestSource {
  readonly ctx: DaemonContext;
  readonly tcp: TCPPeer;
  readonly principal: string | null;
  readonly access: TargetAccess | null;
}

// The context a request over TCP runs on, scoped to the principal it acts
// as; a refusal throws.
export function requireTCPRequestContext(
  source: TCPRequestSource,
  method: string,
  as: RequestPrincipal | null,
): DaemonContext {
  if (isOwnerOnlyMethod(method)) {
    throw new DaemonError('unauthorized', `${method} is open to the daemon's owner only`);
  }

  if (as === null) {
    throw new DaemonError('unauthorized', 'a request over TCP must act as a principal with as');
  }

  if (!source.ctx.hasListedPrincipal(as.principal)) {
    source.tcp.recordRefusedPrincipal();

    throw new DaemonError(
      'unauthorized',
      `principal '${as.principal}' is not listed in principals`,
    );
  }

  const scope = findRequestScope(source.ctx, source.principal, source.access, as.principal);

  if (scope === null) {
    throw new DaemonError('internal', 'a request over TCP resolved to the owner scope');
  }

  return buildScopedContext(source.ctx, scope.access, scope.keyNamespace);
}
