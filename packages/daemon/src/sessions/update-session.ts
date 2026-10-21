import type { SessionID } from '@atc/core';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionChanges } from './session-changes';
import type { SessionRegistry } from './session-registry';
import { updateRecordIdentity } from './update-record-identity';

interface UpdateSessionDeps {
  readonly registry: Pick<SessionRegistry, 'sessions' | 'requireExecution'>;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange' | 'tryWriteFleet' | 'writeStatus'>;
  readonly callbacks: Pick<SessionCallbacks, 'onEvent' | 'findRecords' | 'log'>;
}

export function updateSession(
  deps: UpdateSessionDeps,
  id: SessionID,
  changes: SessionChanges,
): boolean | 'shared_host' | 'agent_named' {
  const session = deps.registry.sessions.find((x) => x.id === id);

  if (session === undefined) {
    return false;
  }

  // the host owner's kill and forget would still end a sub-session in its
  // host, so it gets no detach or pin of its own
  if (
    session.parent !== null &&
    session.hostKey !== session.id &&
    (changes.parent === null || changes.pinned === true)
  ) {
    return 'shared_host';
  }

  // detach before any pin applies, so the pin, kill, and forget no longer
  // follow the former parent
  if (changes.parent === null && session.parent !== null) {
    session.parent = null;

    deps.callbacks.onEvent('state', session);
  }

  const renameSkipped =
    changes.name !== undefined && changes.name !== '' && session.namedBy === 'agent';

  if (changes.name !== undefined && changes.name !== '' && !renameSkipped) {
    session.name = changes.name;

    // auto-summaries stop overwriting a user-strength name, while an
    // in-session rename still wins
    session.namedBy = 'user';
    void updateRecordIdentity(deps, session);
    deps.callbacks.onEvent('renamed', session);
  }

  if (changes.pinned !== undefined && changes.pinned !== session.pinned) {
    session.pinned = changes.pinned;

    deps.callbacks.onEvent('state', session);
  }

  void deps.fleet.tryWriteFleet(session.id);
  deps.fleet.writeStatus();
  deps.fleet.emitChange();

  return renameSkipped ? 'agent_named' : true;
}
