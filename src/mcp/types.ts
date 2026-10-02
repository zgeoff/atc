import type { DaemonFeature } from '../protocol/daemon-features';
import type { ApprovalState } from './approval-state';
import type { openMCPAuth } from './open-mcp-auth';

// The slice of the daemon client the tool handlers need: requests, and the
// features the connected daemon announced at its handshake. A request that
// lists required features is checked against the connection it is about to
// ride, every time it is sent, and refused unsent when that daemon lacks one.
export interface FleetCaller {
  readonly sendRequest: (
    m: string,
    p?: Readonly<Record<string, unknown>>,
    required?: readonly DaemonFeature[],
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly readFeatures: () => Promise<ReadonlySet<DaemonFeature>>;
}

export interface ToolContext {
  readonly callerSessionID: string | null;

  // Who a sent message is from. A `fixed` sender is always used; a `default`
  // one gives way to a sender the tool call gives.
  readonly sender: { readonly kind: 'fixed' | 'default'; readonly name: string };
}

/**
 * The columns of the authorization server's database that atc reads and
 * writes itself. better-auth owns the tables and their migrations; dates are
 * ISO 8601 strings and string lists are JSON arrays.
 */
export interface MCPAuthSchema {
  readonly oauthClient: {
    readonly id: string;
    readonly clientId: string;
    readonly name: string | null;
    readonly redirectUris: string;
    readonly createdAt: string | null;
  };
  readonly oauthAccessToken: {
    readonly id: string;
    readonly token: string;
    readonly clientId: string;
    readonly sessionId: string | null;
    readonly authorizationCodeId: string | null;
  };
  readonly oauthRefreshToken: {
    readonly id: string;
    readonly clientId: string;
    readonly sessionId: string | null;
    readonly authorizationCodeId: string | null;
    readonly scopes: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly revoked: string | null;
  };
  readonly oauthConsent: { readonly id: string; readonly clientId: string };
  readonly oauthResource: { readonly identifier: string };
  readonly session: { readonly id: string; readonly expiresAt: string };

  // When each grant last reached /mcp, keyed by the grant's authorization code id.
  readonly atc_grant_use: { readonly grant_id: string; readonly last_used_at: string };
}

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
}
