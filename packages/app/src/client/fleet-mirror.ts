import type { DaemonClient } from '@atc/protocol/client';
import { toMirrorSession } from './to-mirror-session';
import type { MirrorSession } from './to-mirror-session';

// The client's mirror of the daemon's fleet, kept fresh by events.
export class FleetMirror {
  sessions: MirrorSession[] = [];

  // When each session last flipped to done, so the Tab jump can prefer the
  // most recently finished turn. Sessions already done before this client
  // connected have no entry and rank last.
  readonly doneAt = new Map<string, number>();

  count = 0;

  upsert(session: Readonly<MirrorSession>) {
    const existing = this.sessions.find((candidate) => candidate.id === session.id);

    if (existing === undefined) {
      this.sessions.push({ ...session });
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
  }

  async refresh(getClient: () => DaemonClient) {
    const list = await getClient().sendRequest('session.list');

    const sessions = list['sessions'];

    if (Array.isArray(sessions)) {
      this.sessions = [];

      for (const raw of sessions) {
        const session = toMirrorSession(raw);

        if (session !== null) {
          this.upsert(session);
        }
      }
    }

    const answer = await getClient()
      .sendRequest('fleet.list')
      .catch(() => ({}) as const);

    const entries = (answer as Record<string, unknown>)['fleet'];

    this.count = Array.isArray(entries) ? entries.length : 0;
  }
}
