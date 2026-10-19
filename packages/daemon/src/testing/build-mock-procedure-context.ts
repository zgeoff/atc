import { buildConnectionRequests } from '../transport/build-connection-requests';
import type { ProcedureContext } from '../transport/procedure-context';
import { buildStubDaemonContext } from './build-stub-daemon-context';

// A procedure's context for the daemon's owner on the local socket. The
// connection's handlers run on the given daemon context unless the
// overrides give handlers of their own.
export function buildMockProcedureContext(
  overrides: Partial<ProcedureContext> = {},
): ProcedureContext {
  const ctx = overrides.ctx ?? buildStubDaemonContext();

  return {
    ctx,
    requests: buildConnectionRequests({
      client: { sendOutput: () => {}, sendEvent: () => {} },
      ctx,
      identity: {
        principal: null,
        callerSession: null,
        peerSession: null,
        helloClient: 'atc/test',
      },
    }),
    as: null,
    sentParams: {},
    answerHello: () => Promise.reject(new Error('the mock procedure context has no handshake')),
    subscribeEvents: () => {
      throw new Error('the mock procedure context has no event feed');
    },
    ...overrides,
  };
}
