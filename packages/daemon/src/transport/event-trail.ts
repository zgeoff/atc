import type { Clock, SessionID } from '@atc/core';
import type { SessionDescriptor } from '@atc/protocol';
import type { EventScope, StateStore } from '@atc/store';
import { isTreeInReach } from '../auth/is-tree-in-reach';
import type { TargetAccess } from '../auth/target-access';
import type { DaemonContext } from '../daemon-context';
import { buildFleetEvents } from '../fleet/build-fleet-events';
import { buildAnswerView } from '../sessions/build-answer-view';
import { buildNoteView } from '../sessions/build-note-view';
import type { SessionManager } from '../sessions/sessions';
import type { EventSignal } from './event-signal';

interface EventTrailDeps {
  readonly mgr: Pick<SessionManager, 'sessions' | 'collectDescriptors'>;
  readonly store: Pick<
    StateStore,
    'collectLatestEvents' | 'collectEventsAfter' | 'findNote' | 'findAnswer'
  >;
  readonly clock: Clock;

  // Wakes a held read once the trail grows.
  readonly eventSignal: Pick<EventSignal, 'generation' | 'disposed' | 'waitForNext'>;
}

type EventsPage = Awaited<ReturnType<DaemonContext['readEvents']>>;

type NoteRead = Awaited<ReturnType<DaemonContext['readNote']>>;

type AnswerRead = Awaited<ReturnType<DaemonContext['readAnswer']>>;

/**
 * Reads the hook-event trail: a page of events after a cursor, held until
 * one arrives or the wait runs out, and one note or message answer by its
 * trail id. Under an access, a read matches only the sessions whose whole
 * tree is on targets the access holds, and names each row by the atc id it
 * was recorded under.
 */
export class EventTrail {
  private readonly mgr: EventTrailDeps['mgr'];

  private readonly store: EventTrailDeps['store'];

  private readonly clock: Clock;

  private readonly eventSignal: EventTrailDeps['eventSignal'];

  constructor(deps: EventTrailDeps) {
    this.mgr = deps.mgr;
    this.store = deps.store;
    this.clock = deps.clock;
    this.eventSignal = deps.eventSignal;
  }

  // A wake for an event the read leaves out (a heartbeat, or another
  // session's event under a session filter) loops back to wait out the
  // rest of the window. The scope is built again after every await, so a
  // session whose tree left the access while the read waited matches
  // nothing, and a read whose scope changed under its query runs again.
  async readEvents(
    afterID: number | null,
    limit: number,
    waitMs: number,
    sessionID: SessionID | null,
    access: TargetAccess | null,
  ): Promise<EventsPage> {
    const deadline = this.clock.now() + waitMs;

    for (;;) {
      const generation = this.eventSignal.generation;
      const scope = this.buildEventScope(sessionID, access);

      // A read from a cursor takes one row past the limit to learn whether
      // more follow; the latest events have nothing after them.
      const rows =
        afterID === null
          ? await this.store.collectLatestEvents(limit, scope)
          : await this.store.collectEventsAfter(afterID, limit + 1, scope);

      if (
        access !== null &&
        JSON.stringify(this.buildEventScope(sessionID, access)) !== JSON.stringify(scope)
      ) {
        continue;
      }

      const remaining = deadline - this.clock.now();

      if (rows.length > 0 || remaining <= 0 || this.eventSignal.disposed) {
        const naming = this.collectNamingDescriptors(access);

        // Under an access an event takes no alias, so each event keeps the
        // atc id it was recorded under for the check that sends it.
        const aliases = access === null ? naming : [];

        return {
          events: buildFleetEvents(rows.slice(0, limit), naming, aliases),
          more: rows.length > limit,
        };
      }

      await this.eventSignal.waitForNext(generation, remaining);
    }
  }

  // Under an access a note takes no alias, so a session in reach never
  // names a note whose own session left the access while the query
  // waited.
  async readNote(id: number, access: TargetAccess | null): Promise<NoteRead> {
    const stored = await this.store.findNote(id, this.buildEventScope(null, access));

    if (stored === null) {
      return null;
    }

    const naming = this.collectNamingDescriptors(access);
    const aliases = access === null ? naming : [];

    return {
      owner: stored.atcID,
      view: buildNoteView(stored, naming, aliases),
    };
  }

  async readAnswer(id: number, access: TargetAccess | null): Promise<AnswerRead> {
    const stored = await this.store.findAnswer(id, this.buildEventScope(null, access));

    if (stored === null) {
      return null;
    }

    const naming = this.collectNamingDescriptors(access);
    const aliases = access === null ? naming : [];

    return {
      owner: stored.atcID,
      view: buildAnswerView(stored, naming, aliases),
    };
  }

  // A live session's scope also matches the rows it wrote under an earlier
  // atc id, through the agent session id a restore carries on. Under an
  // access, the scope holds only the atc ids of the sessions whose whole
  // tree is on targets the access holds, so a session outside it matches
  // nothing, as a session never seen does. It holds no agent session id
  // there: a session on another target can resume the same agent session,
  // and its rows would match.
  private buildEventScope(
    sessionID: SessionID | null,
    access: TargetAccess | null,
  ): EventScope | null {
    const sessions = this.mgr.sessions;

    if (access === null) {
      if (sessionID === null) {
        return null;
      }

      const agentSessionID = sessions.find((x) => x.id === sessionID)?.agentSessionID;

      return {
        atcIDs: [sessionID],
        agentSessionIDs: agentSessionID === undefined ? [] : [agentSessionID],
      };
    }

    const visible = sessions.filter(
      (x) => (sessionID === null || x.id === sessionID) && isTreeInReach(sessions, x.id, access),
    );

    return { atcIDs: visible.map((x) => x.id), agentSessionIDs: [] };
  }

  // The sessions that may name a trail row: under an access, only those
  // whose whole tree is on targets it holds.
  private collectNamingDescriptors(access: TargetAccess | null): SessionDescriptor[] {
    const sessions = this.mgr.sessions;

    const reached = new Set(
      sessions
        .filter((x) => access === null || isTreeInReach(sessions, x.id, access))
        .map((x) => x.id),
    );

    return this.mgr.collectDescriptors().filter((d) => reached.has(d.id));
  }
}
