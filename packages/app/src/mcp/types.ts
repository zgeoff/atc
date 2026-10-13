import type { Clock } from '@atc/core/system-clock';
import type { DaemonFeature } from '@atc/protocol/daemon-features';
import type { ApprovalState } from './approval-state';
import type { openMCPAuth } from './open-mcp-auth';

/**
 * A feature the tool list can depend on: one a daemon announces, or
 * `fleet.daemons`, which only a caller that routes across named daemons
 * announces, for the tools and inputs that pick a daemon.
 */
export type FleetFeature = DaemonFeature | 'fleet.daemons';

// The slice of the daemon client the tool handlers need: requests, and the
// features the connected daemon announced at its handshake. A request that
// lists required features is checked against the connection it is about to
// ride, every time it is sent, and refused unsent when that daemon lacks one.
// A request with a principal acts as that principal.
export interface FleetCaller {
  readonly sendRequest: (
    m: string,
    p?: Readonly<Record<string, unknown>>,
    required?: readonly DaemonFeature[],
    principal?: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly readFeatures: () => Promise<ReadonlySet<FleetFeature>>;
}

export interface ToolContext {
  readonly callerSessionID: string | null;

  // Who a sent message is from. A `fixed` sender is always used; a `default`
  // one gives way to a sender the tool call gives.
  readonly sender: { readonly kind: 'fixed' | 'default'; readonly name: string };
}

/**
 * Where a request came from, as the HTTP request shows it: the socket's peer
 * address, which is the requester or the proxy or tunnel in front of atc, the
 * `CF-Connecting-IP` header, which anyone can send, and the user agent.
 */
export interface Requester {
  readonly socketAddress: string | null;
  readonly connectingIP: string | null;
  readonly userAgent: string | null;
}

/**
 * The kinds of sign-in event, each with the outcomes and reasons the
 * security-event contract allows for it.
 */
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
      readonly reason?: 'wrong_code' | 'locked' | 'expired';
    }
  | { readonly kind: 'consent'; readonly outcome: 'allowed' }
  | { readonly kind: 'consent'; readonly outcome: 'denied'; readonly reason?: 'none_ticked' };

/**
 * Why an authorization request was refused before the operator saw it: an
 * error code better-auth gives, a Host or origin atc does not serve, or
 * `other` for any code outside the list.
 */
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

/**
 * One sign-in event, before the log bounds its fields. `path` is the
 * request's path, which the log turns into a fixed route.
 */
export type SecurityEvent = SecurityOutcome & {
  readonly path: string;
  readonly requester: Requester;
  readonly client?: { readonly id: string; readonly name: string };
  readonly redirectHost?: string;
  readonly correlationID?: string;
};

/**
 * The authorization server's store: the better-auth instance and the
 * database under it.
 */
type MCPAuth = Awaited<ReturnType<typeof openMCPAuth>>;

// What every HTTP route reads: the daemon, the server's own identity, the
// authorization server, and the approvals waiting for the operator.
export interface HTTPServerContext {
  readonly caller: FleetCaller;
  readonly build: string;

  // The public origin: the OAuth issuer.
  readonly origin: string;

  // `<origin>/mcp`: the one resource every token is bound to.
  readonly resource: string;
  readonly store: MCPAuth;
  readonly approvals: ApprovalState;
  readonly printApproval: (line: string) => void;

  // Receives each sign-in outcome as a security event.
  readonly security: { readonly record: (event: SecurityEvent) => void };

  // The time the routes stamp and check expiries against.
  readonly clock: Clock;
}
