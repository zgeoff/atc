import type { Clock, SessionID } from '@atc/core';
import type { RestartResult, SessionDescriptor } from '@atc/protocol';
import type { EventScope, StateStore } from '@atc/store';
import { isTreeInReach } from '../auth/is-tree-in-reach';
import type { TargetAccess } from '../auth/target-access';
import type { DaemonContext } from '../daemon-context';
import { buildFleetEvents } from '../fleet/build-fleet-events';
import { buildAnswerView } from '../sessions/build-answer-view';
import { buildNoteView } from '../sessions/build-note-view';
import type { SessionManager } from '../sessions/sessions';
import type { EventSignal } from './event-signal';
import { formatRestartDetail } from './format-restart-detail';

interface EventTrailDeps {
  readonly manager: Pick<SessionManager, 'sessions' | 'collectDescriptors'>;
  readonly store: Pick<
    StateStore,
    'readLatestEvents' | 'readEventsAfter' | 'readNote' | 'readAnswer' | 'recordRestart'
  >;
  readonly clock: Clock;

  // Wakes a held read once the trail grows.
  readonly eventSignal: Pick<EventSignal, 'generation' | 'disposed' | 'waitForNext' | 'emit'>;
}

type EventsPage = Awaited<ReturnType<DaemonContext['readEvents']>>;

type NoteRead = Awaited<ReturnType<DaemonContext['readNote']>>;

type AnswerRead = Awaited<ReturnType<DaemonContext['readAnswer']>>;

export class EventTrail {
  private readonly manager: EventTrailDeps['manager'];

  private readonly store: EventTrailDeps['store'];

  private readonly clock: Clock;

  private readonly eventSignal: EventTrailDeps['eventSignal'];

  constructor(deps: EventTrailDeps) {
    this.manager = deps.manager;
    this.store = deps.store;
    this.clock = deps.clock;
    this.eventSignal = deps.eventSignal;
  }

  // A failed write never stops the restart's live event, which still reaches
  // the readers connected now.
  async recordRestart(result: RestartResult): Promise<void> {
    try {
      await this.store.recordRestart(result, formatRestartDetail(result), this.clock.now());
    } catch {
      return;
    }

    this.eventSignal.emit();
  }

  // A wake for an event the read leaves out loops back to wait out the rest of the window.
  // The scope is built again after every await, so a session whose tree left the access
  // while the read waited matches nothing.
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
          ? await this.store.readLatestEvents(limit, scope)
          : await this.store.readEventsAfter(afterID, limit + 1, scope);

      if (
        access !== null &&
        JSON.stringify(this.buildEventScope(sessionID, access)) !== JSON.stringify(scope)
      ) {
        // the scope changed under the query, so the read runs again
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
    const stored = await this.store.readNote(id, this.buildEventScope(null, access));

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
    const stored = await this.store.readAnswer(id, this.buildEventScope(null, access));

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

  // A live session's scope also matches the rows it wrote under an earlier atc id, through
  // the agent session id a restore carries on.
  private buildEventScope(
    sessionID: SessionID | null,
    access: TargetAccess | null,
  ): EventScope | null {
    const sessions = this.manager.sessions;

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

    // no agent session id under an access: a session on another target can resume the same
    // agent session, and its rows would match
    return { atcIDs: visible.map((x) => x.id), agentSessionIDs: [] };
  }

  // The sessions that may name a trail row: under an access, only those
  // whose whole tree is on targets it holds.
  private collectNamingDescriptors(access: TargetAccess | null): SessionDescriptor[] {
    const sessions = this.manager.sessions;

    const reached = new Set(
      sessions
        .filter((x) => access === null || isTreeInReach(sessions, x.id, access))
        .map((x) => x.id),
    );

    return this.manager.collectDescriptors().filter((descriptor) => reached.has(descriptor.id));
  }
}
