import type { DaemonClient } from '@atc/protocol/client';
import { createSessionMap } from './create-session-map';
import type { SessionMap } from './create-session-map';
import { isSameSessionKey, toSessionKey } from './session-key';
import type { DaemonName, SessionKey } from './session-key';
import { toMirrorSession } from './to-mirror-session';
import type { MirrorSession } from './to-mirror-session';

// The client's mirror of every daemon's fleet, kept fresh by events.
export interface FleetMirror {
  sessions: MirrorSession[];

  // When each session last flipped to done, so the Tab jump can prefer the
  // most recently finished turn. Sessions already done before this client
  // connected have no entry and rank last.
  readonly doneAt: SessionMap<number>;

  // The primary daemon's stored fleet, which `R` restores.
  count: number;

  readonly upsert: (session: Readonly<MirrorSession>) => void;
  readonly find: (key: SessionKey) => MirrorSession | undefined;
  readonly has: (key: SessionKey) => boolean;

  // Replaces the rows of one daemon with the daemon's own list, and forgets
  // the done time of each session that daemon no longer holds.
  readonly refresh: (
    daemon: DaemonName,
    client: Pick<DaemonClient, 'sendRequest'>,
  ) => Promise<void>;
}

export function createFleetMirror(primary: DaemonName): FleetMirror {
  const self: FleetMirror = {
    sessions: [],
    doneAt: createSessionMap<number>(),
    count: 0,

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
        existing.state = session.state;
        existing.unread = session.unread;
        existing.lastMsg = session.lastMsg;
        existing.kind = session.kind;
        existing.alive = session.alive;
        existing.resumable = session.resumable;
        existing.canEject = session.canEject;
        existing.agent = session.agent;
        existing.target = session.target;
        existing.model = session.model;
        existing.harness = session.harness;
      }
    },

    find: (key) => self.sessions.find((session) => isSameSessionKey(session, key)),
    has: (key) => self.sessions.some((session) => isSameSessionKey(session, key)),

    refresh: async (daemon, client) => {
      const list = await client.sendRequest('session.list');

      const sessions = list['sessions'];

      if (Array.isArray(sessions)) {
        const gone = self.sessions.filter((session) => session.daemon === daemon);

        self.sessions = self.sessions.filter((session) => session.daemon !== daemon);

        for (const raw of sessions) {
          const session = toMirrorSession(raw, daemon);

          if (session !== null) {
            self.upsert(session);
          }
        }

        for (const session of gone) {
          if (!self.has(toSessionKey(session))) {
            self.doneAt.remove(toSessionKey(session));
          }
        }
      }

      if (daemon !== primary) {
        return;
      }

      const answer: Readonly<Record<string, unknown>> = await client
        .sendRequest('fleet.list')
        .catch(() => ({}) as const);

      const entries = answer['fleet'];

      self.count = Array.isArray(entries) ? entries.length : 0;
    },
  };

  return self;
}
