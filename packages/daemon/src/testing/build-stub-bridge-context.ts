import type { BridgeContext } from '../transport/start-session-bridge';

export function buildStubBridgeContext(overrides: Partial<BridgeContext> = {}): BridgeContext {
  return {
    findSession: () => {},
    applyHookEvent: () => {},
    applyNote: () => Promise.resolve(true),
    attachTap: () => 'ok',
    ackMessage: () => Promise.resolve('unknown'),
    ackNotice: () => Promise.resolve('unknown'),
    detachTap: () => {},
    ...overrides,
  };
}
