import type { EventMsg } from '@atc/protocol/wire';
import type { SessionDescriptor, SessionID } from '@atcx/contract';
import { PROTOCOL_VERSION } from '@atcx/contract/light';
import type { SessionManager } from './create-session-manager';
import type { Session } from './session';
import type { SessionEventKind } from './session-event-kind';

export function buildSessionEvent(
  manager: SessionManager,
  kind: SessionEventKind,
  live: Session,
): EventMsg | null {
  const builders: Record<SessionEventKind, () => EventMsg | null> = {
    added: () => {
      const session = findDescriptor(manager, live.id);

      return session === null ? null : { version: PROTOCOL_VERSION, ev: 'SessionAdded', session };
    },
    state: () => {
      const session = findDescriptor(manager, live.id);

      return session === null ? null : { version: PROTOCOL_VERSION, ev: 'SessionState', session };
    },
    renamed: () => ({
      version: PROTOCOL_VERSION,
      ev: 'SessionRenamed',
      sessionID: live.id,
      name: live.name,
      namedBy: live.namedBy,
    }),
    removed: () => ({ version: PROTOCOL_VERSION, ev: 'SessionRemoved', sessionID: live.id }),
  };

  return builders[kind]();
}

function findDescriptor(manager: SessionManager, id: SessionID): SessionDescriptor | null {
  return manager.collectDescriptors().find((x) => x.id === id) ?? null;
}
