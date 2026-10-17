import type { SessionID } from '@atc/core';
import type { SessionDescriptor } from '@atc/protocol';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { Session } from './session';
import type { SessionEventKind } from './session-event-kind';
import type { SessionManager } from './sessions';

export function buildSessionEvent(
  mgr: SessionManager,
  kind: SessionEventKind,
  s: Session,
): EventMsg | null {
  const builders: Record<SessionEventKind, () => EventMsg | null> = {
    added: () => {
      const session = findDescriptor(mgr, s.id);

      return session === null ? null : { v: PROTOCOL_V, ev: 'SessionAdded', session };
    },
    state: () => {
      const session = findDescriptor(mgr, s.id);

      return session === null ? null : { v: PROTOCOL_V, ev: 'SessionState', session };
    },
    renamed: () => ({
      v: PROTOCOL_V,
      ev: 'SessionRenamed',
      s: s.id,
      name: s.name,
      namedBy: s.namedBy,
    }),
    removed: () => ({ v: PROTOCOL_V, ev: 'SessionRemoved', s: s.id }),
  };

  return builders[kind]();
}

function findDescriptor(mgr: SessionManager, id: SessionID): SessionDescriptor | null {
  return mgr.collectDescriptors().find((x) => x.id === id) ?? null;
}
