import type { AgentID } from '@atc/core';
import type { GrantScope, SessionID } from '@atcx/contract';

export interface SpawnGrantRequest {
  readonly requested: readonly GrantScope[] | null | undefined;
  readonly sessionID: SessionID;
  readonly agent: AgentID;
  readonly target: string;
  readonly isRemote: boolean;
  readonly takesAtcMCP: boolean;

  // The session whose host the new one runs on, and the scopes it holds.
  readonly hostKey: SessionID;
  readonly hostAccess: readonly GrantScope[];
}

export type SpawnGrantDecision =
  | { readonly kind: 'granted'; readonly atcAccess: readonly GrantScope[] | null }
  | {
      readonly kind: 'refused';
      readonly code: 'bad_args' | 'unauthorized';
      readonly message: string;
    };

// A harness on the daemon's machine reaches the daemon's socket as its
// owner, so no grant could narrow it, and every process inside one host can
// open each bridge socket there.
export function decideSpawnGrant(request: SpawnGrantRequest): SpawnGrantDecision {
  const requested = request.requested ?? [];

  if (requested.length === 0) {
    return { kind: 'granted', atcAccess: null };
  }

  if (!request.isRemote) {
    return {
      kind: 'refused',
      code: 'bad_args',
      message: `atcAccess takes a target that runs the agent on another machine; a session on target '${request.target}' reaches atc as the daemon's owner`,
    };
  }

  if (!request.takesAtcMCP) {
    return {
      kind: 'refused',
      code: 'bad_args',
      message: `agent '${request.agent}' takes no atc MCP server on a remote target, so it cannot take atcAccess`,
    };
  }

  const missing =
    request.hostKey === request.sessionID
      ? []
      : requested.filter((scope) => !request.hostAccess.includes(scope));

  if (missing.length > 0) {
    return {
      kind: 'refused',
      code: 'unauthorized',
      message: `the session shares the host of session '${request.hostKey}', which lacks atc scope ${missing.join(', ')}, so the spawn cannot grant it`,
    };
  }

  return { kind: 'granted', atcAccess: requested };
}
