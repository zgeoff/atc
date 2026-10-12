import type { DaemonFeature } from '../protocol/daemon-features';
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
