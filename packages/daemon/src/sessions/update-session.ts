import type { SessionID } from '@atc/core';
import type { SessionFleetWriter } from '../fleet/session-fleet-writer';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionChanges } from './session-changes';
import type { SessionRegistry } from './session-registry';

interface UpdateSessionDeps {
  readonly registry: Pick<SessionRegistry, 'sessions'>;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange' | 'tryWriteFleet' | 'writeStatus'>;
  readonly callbacks: Pick<SessionCallbacks, 'onEvent'>;
}

export function updateSession(
  deps: UpdateSessionDeps,
  id: SessionID,
  changes: SessionChanges,
): boolean | 'shared_host' | 'agent_named' {
  const s = deps.registry.sessions.find((x) => x.id === id);

  if (s === undefined) {
    return false;
  }

  // the host owner's kill and forget would still end a sub-session in its
  // host, so it gets no detach or pin of its own
  if (
    s.parent !== null &&
    s.hostKey !== s.id &&
    (changes.parent === null || changes.pinned === true)
  ) {
    return 'shared_host';
  }

  // detach before any pin applies, so the pin, kill, and forget no longer
  // follow the former parent
  if (changes.parent === null && s.parent !== null) {
    s.parent = null;

    deps.callbacks.onEvent('state', s);
  }

  const renameSkipped = changes.name !== undefined && changes.name !== '' && s.namedBy === 'agent';

  if (changes.name !== undefined && changes.name !== '' && !renameSkipped) {
    s.name = changes.name;

    // auto-summaries stop overwriting a user-strength name, while an
    // in-session rename still wins
    s.namedBy = 'user';

    deps.callbacks.onEvent('renamed', s);
  }

  if (changes.pinned !== undefined && changes.pinned !== s.pinned) {
    s.pinned = changes.pinned;

    deps.callbacks.onEvent('state', s);
  }

  void deps.fleet.tryWriteFleet(s.id);
  deps.fleet.writeStatus();
  deps.fleet.emitChange();

  return renameSkipped ? 'agent_named' : true;
}
