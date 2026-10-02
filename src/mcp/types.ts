// The slice of the daemon client the tool handlers need.
export interface FleetCaller {
  readonly sendRequest: (
    m: string,
    p?: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

export interface ToolContext {
  readonly callerSessionID: string | null;
  readonly defaultFrom: string;
}

// An OAuth client as the authorization server sees it, from either a
// registration or a client metadata document.
export interface OAuthClientView {
  readonly clientID: string;
  readonly name: string;
  readonly redirectURIs: readonly string[];
}
