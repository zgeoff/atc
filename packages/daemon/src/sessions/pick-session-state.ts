import type { SessionLifecycle } from '@atc/protocol';

type SessionState = 'running' | 'needs_you' | 'done' | 'exited';

export function pickSessionState(
  lifecycle: Readonly<SessionLifecycle>,
  attention: SessionState,
): SessionState {
  return lifecycle.harness === 'running' ? attention : 'exited';
}
