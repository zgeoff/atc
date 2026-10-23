import type { Clock } from '@atc/core';
import type { EventScope, StateStore } from '@atc/store';
import type { RestartResult, SessionDescriptor, SessionID } from '@atcx/contract';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import { isTreeInReach } from '../auth/is-tree-in-reach';
import type { DaemonContext } from '../daemon-context';
import { buildFleetEvents } from '../fleet/build-fleet-events';
import { buildAnswerView } from '../sessions/build-answer-view';
import { buildNoteView } from '../sessions/build-note-view';
import type { SessionManager } from '../sessions/create-session-manager';
import type { EventSignal } from './create-event-signal';
import { formatRestartDetail } from './format-restart-detail';

type EventsPage = Awaited<ReturnType<DaemonContext['readEvents']>>;

type NoteRead = Awaited<ReturnType<DaemonContext['readNote']>>;

type AnswerRead = Awaited<ReturnType<DaemonContext['readAnswer']>>;

export interface EventTrail {
  // A failed write never stops the restart's live event, which still reaches
  // the readers connected now, so the failure only goes to the daemon's log.
  readonly recordRestart: (result: RestartResult) => Promise<void>;

  // A wake for an event the read leaves out loops back to wait out the rest of the window.
  // The scope is built again after every await, so a session whose tree left the access
  // while the read waited matches nothing.
  readonly readEvents: (
    afterID: number | null,
    limit: number,
    waitMs: number,
    sessionID: SessionID | null,
    access: TargetAccess | null,
  ) => Promise<EventsPage>;

  // Under an access a note takes no alias, so a session in reach never
  // names a note whose own session left the access while the query
  // waited.
  readonly readNote: (id: number, access: TargetAccess | null) => Promise<NoteRead>;

  readonly readAnswer: (id: number, access: TargetAccess | null) => Promise<AnswerRead>;
}

interface EventTrailDeps {
  readonly manager: Pick<SessionManager, 'sessions' | 'collectDescriptors' | 'log'>;
  readonly store: Pick<
    StateStore,
    'readLatestEvents' | 'readEventsAfter' | 'readNote' | 'readAnswer' | 'recordRestart'
  >;
  readonly clock: Clock;

  // Wakes a held read once the trail grows.
  readonly eventSignal: Pick<EventSignal, 'generation' | 'disposed' | 'waitForNext' | 'emit'>;
}

export function createEventTrail(deps: EventTrailDeps): EventTrail {
  const manager = deps.manager;
  const store = deps.store;
  const clock = deps.clock;
  const eventSignal = deps.eventSignal;

  // A live session's scope also matches the rows it wrote under an earlier atc id, through
  // the agent session id a restore carries on.
  const buildEventScope = (
    sessionID: SessionID | null,
    access: TargetAccess | null,
  ): EventScope | null => {
    const sessions = manager.sessions;

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
  };

  // The sessions that may name a trail row: under an access, only those
  // whose whole tree is on targets it holds.
  const collectNamingDescriptors = (access: TargetAccess | null): SessionDescriptor[] => {
    const sessions = manager.sessions;

    const reached = new Set(
      sessions
        .filter((x) => access === null || isTreeInReach(sessions, x.id, access))
        .map((x) => x.id),
    );

    return manager.collectDescriptors().filter((descriptor) => reached.has(descriptor.id));
  };

  return {
    recordRestart: async (result) => {
      try {
        await store.recordRestart(result, formatRestartDetail(result), clock.now());
      } catch (error) {
        manager.log(
          `atc daemon.restarted for restart run ${result.runID}: the event trail write failed, so a reader that connects later misses it: ${String(error)}`,
        );

        return;
      }

      eventSignal.emit();
    },

    readEvents: async (afterID, limit, waitMs, sessionID, access) => {
      const deadline = clock.now() + waitMs;

      for (;;) {
        const generation = eventSignal.generation;
        const scope = buildEventScope(sessionID, access);

        // A read from a cursor takes one row past the limit to learn whether
        // more follow; the latest events have nothing after them.
        const rows =
          afterID === null
            ? await store.readLatestEvents(limit, scope)
            : await store.readEventsAfter(afterID, limit + 1, scope);

        if (
          access !== null &&
          JSON.stringify(buildEventScope(sessionID, access)) !== JSON.stringify(scope)
        ) {
          // the scope changed under the query, so the read runs again
          continue;
        }

        const remaining = deadline - clock.now();

        if (rows.length > 0 || remaining <= 0 || eventSignal.disposed) {
          const naming = collectNamingDescriptors(access);

          // Under an access an event takes no alias, so each event keeps the
          // atc id it was recorded under for the check that sends it.
          const aliases = access === null ? naming : [];

          return {
            events: buildFleetEvents(rows.slice(0, limit), naming, aliases),
            more: rows.length > limit,
          };
        }

        await eventSignal.waitForNext(generation, remaining);
      }
    },

    readNote: async (id, access) => {
      const stored = await store.readNote(id, buildEventScope(null, access));

      if (stored === null) {
        return null;
      }

      const naming = collectNamingDescriptors(access);
      const aliases = access === null ? naming : [];

      return {
        owner: stored.atcID,
        view: buildNoteView(stored, naming, aliases),
      };
    },

    readAnswer: async (id, access) => {
      const stored = await store.readAnswer(id, buildEventScope(null, access));

      if (stored === null) {
        return null;
      }

      const naming = collectNamingDescriptors(access);
      const aliases = access === null ? naming : [];

      return {
        owner: stored.atcID,
        view: buildAnswerView(stored, naming, aliases),
      };
    },
  };
}
