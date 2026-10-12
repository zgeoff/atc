import type { BridgeContext } from '../daemon/start-session-bridge';

/**
 * The daemon's side of a session bridge, for tests that drive one bridge
 * without a daemon behind it: no live session, hook events that go nowhere,
 * every note recorded, every tap attached, every ack for an unknown
 * message, and detaches that do nothing. An override replaces the member it
 * names.
 */
export function buildStubBridgeContext(overrides: Partial<BridgeContext> = {}): BridgeContext {
  return {
    findSession: () => {},
    applyHookEvent: () => {},
    applyNote: () => Promise.resolve(true),
    attachTap: () => 'ok',
    ackMessage: () => Promise.resolve('unknown'),
    detachTap: () => {},
    ...overrides,
  };
}
