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

  upsert(d: Readonly<MirrorSession>) {
    const existing = this.sessions.find((s) => s.id === d.id);

    if (existing === undefined) {
      this.sessions.push({ ...d });
    } else {
      existing.name = d.name;
      existing.pinned = d.pinned;
      existing.parent = d.parent;
      existing.lastAttachedAt = d.lastAttachedAt;
      existing.repoRoot = d.repoRoot;
      existing.state = d.state;
      existing.unread = d.unread;
      existing.lastMsg = d.lastMsg;
      existing.kind = d.kind;
      existing.alive = d.alive;
      existing.resumable = d.resumable;
      existing.canEject = d.canEject;
      existing.agent = d.agent;
      existing.target = d.target;
      existing.model = d.model;
      existing.harness = d.harness;
    }
  }

  async refresh(getClient: () => DaemonClient) {
    const list = await getClient().sendRequest('session.list');

    const sessions = list['sessions'];

    if (Array.isArray(sessions)) {
      this.sessions = [];

      for (const raw of sessions) {
        const d = toMirrorSession(raw);

        if (d !== null) {
          this.upsert(d);
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
