import type { Clock } from '@atc/core';
import type { Principal } from '@atc/protocol';
import type { ApprovalState } from './approval-state';
import type { EnrollmentState } from './enrollment-state';
import type { openMCPAuth } from './open-mcp-auth';

// `fleet.daemons` is announced only by a caller that routes across named daemons.
export type FleetFeature = 'fleet.daemons';

export interface FleetCaller {
  readonly sendRequest: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    principal?: Principal,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly readFeatures: () => Promise<ReadonlySet<FleetFeature>>;
}

export interface ToolContext {
  readonly callerSessionID: string | null;
}

export interface Requester {
  readonly socketAddress: string | null;

  // the `CF-Connecting-IP` header. Anyone can send it, so it is `trusted`
  // only when the socket's peer is a proxy the owner listed.
  readonly connectingIP: {
    readonly address: string;
    readonly provenance: 'trusted' | 'unverified';
  } | null;
  readonly userAgent: string | null;
}

export type SecurityOutcome =
  | { readonly kind: 'authorize_started'; readonly outcome: 'accepted' }
  | {
      readonly kind: 'authorize_started';
      readonly outcome: 'rejected';
      readonly reason: 'rate_limited';
    }
  | {
      readonly kind: 'authorize_invalid';
      readonly outcome: 'rejected';
      readonly reason: AuthorizeInvalidReason;
    }
  | { readonly kind: 'owner_auth'; readonly outcome: 'succeeded' }
  | {
      readonly kind: 'owner_auth';
      readonly outcome: 'failed';
      readonly reason?: OwnerAuthFailure;
    }
  | { readonly kind: 'consent'; readonly outcome: 'allowed' }
  | { readonly kind: 'consent'; readonly outcome: 'denied'; readonly reason?: 'none_ticked' }
  | {
      readonly kind: 'token_exchange';
      readonly outcome: 'rejected';
      readonly reason: TokenExchangeReason;
    }
  | { readonly kind: 'bearer'; readonly outcome: 'rejected'; readonly reason: BearerReason };

export type OwnerAuthFailure =
  | 'assertion_failed'
  | 'locked'
  | 'expired'
  | 'not_enrolled'
  | 'invalid_token';

export type AuthorizeInvalidReason =
  | 'invalid_client'
  | 'client_disabled'
  | 'invalid_redirect'
  | 'unauthorized_client'
  | 'unsupported_response_type'
  | 'invalid_request'
  | 'invalid_scope'
  | 'invalid_target'
  | 'bad_host'
  | 'bad_origin'
  | 'other';

export type TokenExchangeReason =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'other';

export type BearerReason = 'malformed' | 'invalid_token';

export type SecurityEvent = SecurityOutcome & {
  readonly path: string;
  readonly requester: Requester;
  readonly client?: { readonly id: string; readonly name: string };
  readonly redirectHost?: string;
  readonly correlationID?: string;
};

type MCPAuth = Awaited<ReturnType<typeof openMCPAuth>>;

// What every HTTP route reads: the daemon, the server's own identity, the
// authorization server, the approvals waiting for the owner, and the
// passkey enrollments in progress.
export interface HTTPServerContext {
  readonly caller: FleetCaller;
  readonly build: string;

  // The public origin: the OAuth issuer.
  readonly origin: string;

  // `<origin>/mcp`: the one resource every token is bound to.
  readonly resource: string;
  readonly store: MCPAuth;
  readonly approvals: ApprovalState;
  readonly enrollments: EnrollmentState;

  // Receives each sign-in outcome and each refused token as a security event.
  readonly security: { readonly record: (event: SecurityEvent) => void };

  // The time the routes stamp and check expiries against.
  readonly clock: Clock;
}
