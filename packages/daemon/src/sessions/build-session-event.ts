import type { SessionID } from '@atc/core';
import type { SessionDescriptor } from '@atc/protocol';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { Session } from './session';
import type { SessionEventKind } from './session-event-kind';
import type { SessionManager } from './sessions';

export function buildSessionEvent(
  manager: SessionManager,
  kind: SessionEventKind,
  live: Session,
): EventMsg | null {
  const builders: Record<SessionEventKind, () => EventMsg | null> = {
    added: () => {
      const session = findDescriptor(manager, live.id);

      return session === null ? null : { v: PROTOCOL_V, ev: 'SessionAdded', session };
    },
    state: () => {
      const session = findDescriptor(manager, live.id);

      return session === null ? null : { v: PROTOCOL_V, ev: 'SessionState', session };
    },
    renamed: () => ({
      v: PROTOCOL_V,
      ev: 'SessionRenamed',
      s: live.id,
      name: live.name,
      namedBy: live.namedBy,
    }),
    removed: () => ({ v: PROTOCOL_V, ev: 'SessionRemoved', s: live.id }),
  };

  return builders[kind]();
}

function findDescriptor(manager: SessionManager, id: SessionID): SessionDescriptor | null {
  return manager.collectDescriptors().find((x) => x.id === id) ?? null;
}
