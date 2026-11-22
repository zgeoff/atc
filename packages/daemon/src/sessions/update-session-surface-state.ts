import { truncateDetail, truncateToBytes } from '@atc/core';
import type { SessionState } from '@atc/protocol';
import type { SessionID } from '@atcx/contract';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import type { SessionRegistry } from './create-session-registry';
import type { SessionCallbacks } from './session-callbacks';

interface UpdateSessionSurfaceStateDeps {
  readonly registry: Pick<SessionRegistry, 'sessions' | 'focusedId'>;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange' | 'tryUpdateFleetEntry'>;
  readonly callbacks: Pick<SessionCallbacks, 'onEvent'>;
}

interface SurfaceStateUpdate {
  readonly id: SessionID;
  readonly state: SessionState;
  readonly message: string;
  readonly result?: string | undefined;
}

export function updateSessionSurfaceState(
  deps: UpdateSessionSurfaceStateDeps,
  update: SurfaceStateUpdate,
): void {
  const session = deps.registry.sessions.find((x) => x.id === update.id);

  if (!session || session.kind !== 'headless') {
    return;
  }

  session.state = update.state;
  session.lastMsg = update.message;
  session.turnFailed = false;
  session.unread = deps.registry.focusedId !== session.id;

  if (update.result !== undefined) {
    session.result = truncateToBytes(update.result, 16_384);
    session.lastDetail = truncateDetail(update.result);
    void deps.fleet.tryUpdateFleetEntry(session.id, { result: session.result });
  }

  deps.callbacks.onEvent('state', session);
  deps.fleet.emitChange();
}
