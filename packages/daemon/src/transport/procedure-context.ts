import type { DaemonAnswer, DaemonEvent, RequestParams } from '@atc/protocol';
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

  // Settles who the connection acts as and answers its handshake.
  readonly answerHello: (
    input: RequestParams<'daemon.hello'>,
  ) => Promise<DaemonAnswer<'daemon.hello'>>;

  // The connection's live events until the signal aborts.
  readonly subscribeEvents: (signal: AbortSignal) => AsyncGenerator<DaemonEvent>;
}
