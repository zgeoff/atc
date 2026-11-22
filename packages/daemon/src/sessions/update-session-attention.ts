import type { SessionID } from '@atcx/contract';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import type { SessionRegistry } from './create-session-registry';
import type { SessionCallbacks } from './session-callbacks';

interface UpdateSessionAttentionDeps {
  readonly registry: Pick<SessionRegistry, 'sessions' | 'focusedId'>;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange'>;
  readonly callbacks: Pick<SessionCallbacks, 'onEvent'>;
}

export function updateSessionAttention(
  deps: UpdateSessionAttentionDeps,
  id: SessionID,
  state: 'needs_you' | 'running' | 'done',
  message: string,
): boolean {
  const session = deps.registry.sessions.find((x) => x.id === id);

  if (!session || session.pty === null || session.state === state) {
    return false;
  }

  const isRaise = state === 'needs_you' && session.state !== 'exited';
  const isLower = state !== 'needs_you' && session.state === 'needs_you';

  if (!isRaise && !isLower) {
    return false;
  }

  session.state = state;
  session.lastMsg = message;
  session.turnFailed = false;

  if (state === 'needs_you') {
    session.unread = deps.registry.focusedId !== session.id;
  }

  deps.callbacks.onEvent('state', session);
  deps.fleet.emitChange();

  return true;
}
