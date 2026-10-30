import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import type { DaemonContext } from '../daemon-context';
import { findEventSession } from './find-event-session';

// What a limited connection is sent for one event, and the sessions that
// event moved out of its view.
interface ViewUpdate {
  readonly events: readonly EventMsg[];
  readonly withdrawn: readonly SessionID[];
}

export interface ConnectionView {
  // Starts the view as the sessions the access reaches now, so one that
  // leaves its reach later is pushed as removed.
  readonly startView: (access: TargetAccess) => void;

  // The event itself reaches the connection when its session is in the view, or is gone
  // from the daemon after the connection was shown it.
  readonly updateView: (event: EventMsg, access: TargetAccess) => ViewUpdate;
}

type ViewContext = Pick<DaemonContext, 'findSessionGrant' | 'canSeeSession' | 'collectSessions'>;

export function createConnectionView(ctx: ViewContext): ConnectionView {
  const shownSessions = new Set<SessionID>();
  const withheldSessions = new Set<SessionID>();
  const shownRequests = new Set<string>();

  // Whether the daemon holds the session but the access does not reach its
  // whole tree.
  const isWithheld = (id: SessionID, access: TargetAccess): boolean =>
    ctx.findSessionGrant(id) !== null && !ctx.canSeeSession(id, access);

  // The event that adds the session to a view, or none when the daemon no
  // longer lists it.
  const buildSessionAdded = (id: SessionID): EventMsg[] => {
    const session = ctx.collectSessions().find((x) => x.id === id);

    return session === undefined ? [] : [{ version: PROTOCOL_V, ev: 'SessionAdded', session }];
  };

  return {
    startView: (access) => {
      for (const session of ctx.collectSessions()) {
        const view = ctx.canSeeSession(session.id, access) ? shownSessions : withheldSessions;

        view.add(session.id);
      }
    },

    updateView: (event, access) => {
      const sessionID = findEventSession(event);
      const request = typeof event['request'] === 'string' ? event['request'] : null;
      const sent: EventMsg[] = [];
      const withdrawn: SessionID[] = [];

      for (const id of shownSessions) {
        if (id !== sessionID && isWithheld(id, access)) {
          shownSessions.delete(id);
          withheldSessions.add(id);
          withdrawn.push(id);
          sent.push({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: id });
        }
      }

      for (const id of withheldSessions) {
        if (ctx.findSessionGrant(id) === null) {
          withheldSessions.delete(id);
        } else if (id !== sessionID && ctx.canSeeSession(id, access)) {
          withheldSessions.delete(id);
          shownSessions.add(id);
          sent.push(...buildSessionAdded(id));
        }
      }

      if (sessionID === null) {
        if (request !== null && shownRequests.has(request)) {
          sent.push(event);
        }

        return { events: sent, withdrawn };
      }

      if (ctx.canSeeSession(sessionID, access)) {
        if (withheldSessions.delete(sessionID) && event.ev !== 'SessionAdded') {
          sent.push(...buildSessionAdded(sessionID));
        }

        shownSessions.add(sessionID);

        if (request !== null) {
          shownRequests.add(request);
        }

        sent.push(event);

        return { events: sent, withdrawn };
      }

      if (isWithheld(sessionID, access)) {
        withheldSessions.add(sessionID);

        if (shownSessions.delete(sessionID)) {
          withdrawn.push(sessionID);
          sent.push({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID });
        }

        return { events: sent, withdrawn };
      }

      // The session is gone from the daemon.
      withheldSessions.delete(sessionID);

      if (shownSessions.has(sessionID)) {
        sent.push(event);
      }

      if (event.ev === 'SessionRemoved') {
        shownSessions.delete(sessionID);
      }

      return { events: sent, withdrawn };
    },
  };
}
