import type { DaemonContext } from '../daemon-context';
import type { ConnectionRequests } from './build-connection-requests';
import type { RequestPrincipal } from './request-deps';

// What one request's procedure runs with: the context scoped to who the
// request acts as, its connection's handlers, and the principal the request
// gives, null when it gives none.
export interface ProcedureContext {
  readonly ctx: DaemonContext;
  readonly requests: ConnectionRequests;
  readonly as: RequestPrincipal | null;
}
