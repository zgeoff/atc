import type { DaemonAnswer, RequestParams } from '@atc/protocol';
import type { DaemonEvent } from '@atcx/contract';
import type { DaemonContext } from '../types';
import type { ConnectionRequests } from './build-connection-requests';
import type { RequestPrincipal } from './request-deps';

export interface ProcedureContext {
  readonly ctx: DaemonContext;
  readonly requests: ConnectionRequests;
  readonly as: RequestPrincipal | null;

  readonly answerHello: (
    input: RequestParams<'daemon.hello'>,
  ) => Promise<DaemonAnswer<'daemon.hello'>>;

  readonly subscribeEvents: (signal: AbortSignal) => AsyncGenerator<DaemonEvent>;
}
