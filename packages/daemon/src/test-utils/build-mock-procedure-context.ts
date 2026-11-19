import { buildConnectionRequests } from '../transport/build-connection-requests';
import type { ProcedureContext } from '../transport/procedure-context';
import { buildStubDaemonContext } from './build-stub-daemon-context';

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
    answerHello: () => Promise.reject(new Error('the mock procedure context has no handshake')),
    subscribeEvents: () => {
      throw new Error('the mock procedure context has no event feed');
    },
    ...overrides,
  };
}
