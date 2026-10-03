import type { SessionLifecycle } from './build-session-lifecycle';

type SessionState = 'running' | 'needs_you' | 'done' | 'exited';

/**
 * The state a session lists with: `exited` whenever its harness is not
 * running, suspended inside a sleeping host included, and otherwise the
 * attention its hooks last reported.
 */
export function pickSessionState(
  lifecycle: Readonly<SessionLifecycle>,
  attention: SessionState,
): SessionState {
  return lifecycle.harness === 'running' ? attention : 'exited';
}
