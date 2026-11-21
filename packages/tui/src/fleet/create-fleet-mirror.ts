import type { DaemonClient } from '@atc/protocol/client';
import type { Clock } from '@zgeoff/std';
import { systemClock } from '@zgeoff/std';
import { z } from 'zod';
import { createSessionMap } from './create-session-map';
import type { SessionMap } from './create-session-map';
import { isSameSessionKey, toSessionKey } from './session-key';
import type { DaemonName, SessionKey } from './session-key';
import { toMirrorSession } from './to-mirror-session';
import type { MirrorSession } from './to-mirror-session';
import type { FleetRow } from './types';

export interface FleetMirror {
  readonly primary: DaemonName;

  sessions: MirrorSession[];

  // Sessions already done before this client connected have no entry and rank last.
  readonly doneAt: SessionMap<number>;

  // the primary daemon's stored fleet
  fleet: FleetRow[];

  readonly upsert: (session: Readonly<MirrorSession>) => void;
  readonly find: (key: SessionKey) => MirrorSession | undefined;
  readonly has: (key: SessionKey) => boolean;

  readonly refresh: (
    daemon: DaemonName,
    client: Pick<DaemonClient, 'sendRequest'>,
  ) => Promise<void>;

  readonly refreshFleet: (client: Pick<DaemonClient, 'sendRequest'>) => Promise<void>;
}

const FLEET_ROW_SCHEMA = z.looseObject({ sessionID: z.string(), exited: z.boolean().optional() });
const FLEET_ANSWER_SCHEMA = z.looseObject({ fleet: z.array(FLEET_ROW_SCHEMA) });

export function createFleetMirror(
  primary: DaemonName,
  clock: Pick<Clock, 'now'> = systemClock,
): FleetMirror {
  const self: FleetMirror = {
    primary,
    sessions: [],
    doneAt: createSessionMap<number>(),
    fleet: [],

    upsert: (session) => {
      const existing = self.find({ daemon: session.daemon, id: session.id });

      if (existing === undefined) {
        self.sessions.push({ ...session });
      } else {
        existing.name = session.name;
        existing.pinned = session.pinned;
        existing.parent = session.parent;
        existing.lastAttachedAt = session.lastAttachedAt;
        existing.repoRoot = session.repoRoot;

        if (existing.state !== session.state) {
          existing.stateSince = clock.now();
        }

        existing.state = session.state;
        existing.unread = session.unread;
        existing.lastMsg = session.lastMsg;
        existing.kind = session.kind;
        existing.alive = session.alive;
        existing.resumable = session.resumable;
        existing.canEject = session.canEject;
        existing.canDestroyHost = session.canDestroyHost;
        existing.agent = session.agent;
        existing.target = session.target;
        existing.place = session.place;
        existing.model = session.model;
        existing.harness = session.harness;
        existing.hostAsleep = session.hostAsleep;
      }
    },

    find: (key) => self.sessions.find((session) => isSameSessionKey(session, key)),
    has: (key) => self.sessions.some((session) => isSameSessionKey(session, key)),

    refresh: async (daemon, client) => {
      const list = await client.sendRequest('session.list');

      const sessions = list['sessions'];

      if (Array.isArray(sessions)) {
        const gone = self.sessions.filter((session) => session.daemon === daemon);

        const known = new Map(gone.map((session) => [session.id, session]));

        self.sessions = self.sessions.filter((session) => session.daemon !== daemon);

        for (const raw of sessions) {
          const session = toMirrorSession(raw, daemon);

          if (session !== null) {
            self.upsert({
              ...session,
              stateSince: pickStateSince(known.get(session.id), session, clock),
            });
          }
        }

        for (const session of gone) {
          if (!self.has(toSessionKey(session))) {
            self.doneAt.remove(toSessionKey(session));
          }
        }
      }

      if (daemon === primary) {
        await self.refreshFleet(client);
      }
    },

    refreshFleet: async (client) => {
      const answer: Readonly<Record<string, unknown>> = await client
        .sendRequest('fleet.list')
        .catch(() => ({}) as const);

      const parsed = FLEET_ANSWER_SCHEMA.safeParse(answer);

      self.fleet = parsed.success
        ? parsed.data.fleet.map((row) => ({
            sessionID: row.sessionID,
            exited: row.exited === true,
          }))
        : [];
    },
  };

  return self;
}

// A session the TUI already knew keeps the time it saw its state begin, so a reconnect does not
// reset it. A session in another state than the TUI last saw began that state just now.
function pickStateSince(
  known: Readonly<MirrorSession> | undefined,
  listed: Readonly<MirrorSession>,
  clock: Pick<Clock, 'now'>,
): number | null {
  if (known === undefined) {
    return null;
  }

  return known.state === listed.state ? known.stateSince : clock.now();
}
