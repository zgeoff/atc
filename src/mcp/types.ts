import type { AuthorizationState } from './authorization-state';
import type { OAuthClientResolver } from './oauth-client-resolver';

// The slice of the daemon client the tool handlers need.
export interface FleetCaller {
  readonly sendRequest: (
    m: string,
    p?: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

export interface ToolContext {
  readonly callerSessionID: string | null;

  // Who a sent message is from. A `fixed` sender is always used; a `default`
  // one gives way to a sender the tool call gives.
  readonly sender: { readonly kind: 'fixed' | 'default'; readonly name: string };
}

// An OAuth client as the authorization server sees it, from either a
// registration or a client metadata document. `verified` is true for a client
// identified by an https client metadata document, whose host proves who
// serves it, and false for one that registered itself.
export interface OAuthClientView {
  readonly clientID: string;
  readonly name: string;
  readonly redirectURIs: readonly string[];
  readonly verified: boolean;
}

// What every HTTP endpoint handler reads: the daemon, the server's own
// identity, and the authorization server's state.
export interface HTTPServerContext {
  readonly caller: FleetCaller;
  readonly build: string;

  // The public origin: the OAuth issuer.
  readonly origin: string;

  // `<origin>/mcp`: the one resource every grant is bound to.
  readonly resource: string;
  readonly authorization: AuthorizationState;
  readonly clients: OAuthClientResolver;
  readonly printApproval: (line: string) => void;
}
