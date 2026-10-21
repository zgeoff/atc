import type { SessionID } from '@atc/core';
import { isRecord, toSessionID } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import type { DaemonContext } from '../daemon-context';

// What a limited connection is sent for one event, and the sessions that
// event moved out of its view.
interface ViewUpdate {
  readonly events: readonly EventMsg[];
  readonly withdrawn: readonly SessionID[];
}

type ViewContext = Pick<DaemonContext, 'findSessionGrant' | 'canSeeSession' | 'collectSessions'>;

export class ConnectionView {
  private readonly ctx: ViewContext;

  private readonly shownSessions = new Set<SessionID>();

  private readonly withheldSessions = new Set<SessionID>();

  private readonly shownRequests = new Set<string>();

  constructor(ctx: ViewContext) {
    this.ctx = ctx;
  }

  // Starts the view as the sessions the access reaches now, so one that
  // leaves its reach later is pushed as removed.
  startView(access: TargetAccess): void {
    for (const session of this.ctx.collectSessions()) {
      const view = this.ctx.canSeeSession(session.id, access)
        ? this.shownSessions
        : this.withheldSessions;

      view.add(session.id);
    }
  }

  // The event itself reaches the connection when its session is in the view, or is gone
  // from the daemon after the connection was shown it.
  updateView(event: EventMsg, access: TargetAccess): ViewUpdate {
    const sessionID = findEventSession(event);
    const request = typeof event['request'] === 'string' ? event['request'] : null;
    const sent: EventMsg[] = [];
    const withdrawn: SessionID[] = [];

    for (const id of this.shownSessions) {
      if (id !== sessionID && this.isWithheld(id, access)) {
        this.shownSessions.delete(id);
        this.withheldSessions.add(id);
        withdrawn.push(id);
        sent.push({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: id });
      }
    }

    for (const id of this.withheldSessions) {
      if (this.ctx.findSessionGrant(id) === null) {
        this.withheldSessions.delete(id);
      } else if (id !== sessionID && this.ctx.canSeeSession(id, access)) {
        this.withheldSessions.delete(id);
        this.shownSessions.add(id);
        sent.push(...this.buildSessionAdded(id));
      }
    }

    if (sessionID === null) {
      if (request !== null && this.shownRequests.has(request)) {
        sent.push(event);
      }

      return { events: sent, withdrawn };
    }

    if (this.ctx.canSeeSession(sessionID, access)) {
      if (this.withheldSessions.delete(sessionID) && event.ev !== 'SessionAdded') {
        sent.push(...this.buildSessionAdded(sessionID));
      }

      this.shownSessions.add(sessionID);

      if (request !== null) {
        this.shownRequests.add(request);
      }

      sent.push(event);

      return { events: sent, withdrawn };
    }

    if (this.isWithheld(sessionID, access)) {
      this.withheldSessions.add(sessionID);

      if (this.shownSessions.delete(sessionID)) {
        withdrawn.push(sessionID);
        sent.push({ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID });
      }

      return { events: sent, withdrawn };
    }

    // The session is gone from the daemon.
    this.withheldSessions.delete(sessionID);

    if (this.shownSessions.has(sessionID)) {
      sent.push(event);
    }

    if (event.ev === 'SessionRemoved') {
      this.shownSessions.delete(sessionID);
    }

    return { events: sent, withdrawn };
  }

  // Whether the daemon holds the session but the access does not reach its
  // whole tree.
  private isWithheld(id: SessionID, access: TargetAccess): boolean {
    return this.ctx.findSessionGrant(id) !== null && !this.ctx.canSeeSession(id, access);
  }

  // The event that adds the session to a view, or none when the daemon no
  // longer lists it.
  private buildSessionAdded(id: SessionID): EventMsg[] {
    const session = this.ctx.collectSessions().find((x) => x.id === id);

    return session === undefined ? [] : [{ version: PROTOCOL_V, ev: 'SessionAdded', session }];
  }
}

// The session an event is about, from its `sessionID` field or its session's id;
// null for an event about no one session.
function findEventSession(event: EventMsg): SessionID | null {
  if (typeof event['sessionID'] === 'string') {
    return toSessionID(event['sessionID']);
  }

  const session = event['session'];

  if (isRecord(session) && typeof session['id'] === 'string') {
    return toSessionID(session['id']);
  }

  return null;
}
