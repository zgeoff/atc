import { PROTOCOL_V } from './protocol';
import type { EventMsg } from './protocol';
import type { SessionID } from './session-id';
import type { Session, SessionDescriptor, SessionEventKind, SessionManager } from './sessions';

/**
 * Builds the wire event for a session-manager notification, or null when the
 * notification carries no descriptor to send: `added` and `state` fold in
 * the current descriptor and skip emitting if the session is gone by the
 * time the descriptor is collected.
 */
export function buildSessionEvent(
  mgr: SessionManager,
  kind: SessionEventKind,
  s: Session,
): EventMsg | null {
  const builders: Record<SessionEventKind, () => EventMsg | null> = {
    added: () => {
      const session = findDescriptor(mgr, s.id);

      return session === null ? null : { v: PROTOCOL_V, ev: 'session.added', session };
    },
    state: () => {
      const session = findDescriptor(mgr, s.id);

      return session === null ? null : { v: PROTOCOL_V, ev: 'session.state', session };
    },
    renamed: () => ({
      v: PROTOCOL_V,
      ev: 'session.renamed',
      s: s.id,
      name: s.name,
      namedBy: s.namedBy,
    }),
    removed: () => ({ v: PROTOCOL_V, ev: 'session.removed', s: s.id }),
  };

  return builders[kind]();
}

function findDescriptor(mgr: SessionManager, id: SessionID): SessionDescriptor | null {
  return mgr.collectDescriptors().find((x) => x.id === id) ?? null;
}
