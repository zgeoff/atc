import { decodeCursor } from '../protocol/decode-cursor';
import { encodeCursor } from '../protocol/encode-cursor';
import { isRecord } from '../shared/report';
import { buildGatewayID } from './build-gateway-id';
import { buildRuledValue } from './build-ruled-value';
import { encodeGatewayCursor } from './encode-gateway-cursor';
import type { IDRule } from './id-rules';
import type { RegistryDaemon } from './types';

/**
 * What one daemon gave an events read: a page of its events in its own
 * order, with the cursor it returned and whether more follow; nothing,
 * because it did not answer; or, for a daemon that started at its newest
 * event, the cursor of that position.
 */
type DaemonEventPage =
  | {
      readonly kind: 'read';
      readonly events: readonly Readonly<Record<string, unknown>>[];
      readonly cursor: string;
      readonly more: boolean;
    }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'started'; readonly cursor: string };

/**
 * One daemon's part of a merge: the daemon, where its part of the cursor
 * stood before the read (absent for a daemon the cursor left out, null for
 * a read of its latest events), and what it gave. `unstarted` marks a page
 * of the latest events of a daemon that had not answered since the read
 * that started the cursor, and whether older events precede that page.
 */
export interface MergeSource {
  readonly daemon: Pick<RegistryDaemon, 'name' | 'incarnation'>;
  readonly before: { readonly cursor: string | null } | null;
  readonly page: DaemonEventPage;
  readonly unstarted?: { readonly olderUnread: boolean };
}

interface MergedEvents {
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly cursor: string;
  readonly more: boolean;
  readonly unavailable: readonly string[];
  readonly started: readonly string[];
  readonly truncated: readonly string[];
}

// The id fields of one event, relative to the event.
const EVENT_RULES: ReadonlyMap<string, IDRule> = new Map([
  ['session', 'id'],
  ['message', 'id'],
  ['parent', 'id'],
  ['note', 'id'],
]);

/**
 * Merges the daemons' pages of one events read into one page of at most
 * `limit` events. Each daemon's events keep their own order, and daemons
 * interleave by timestamp as a best effort, since daemon clocks can skew.
 * Each daemon's part of the returned cursor advances only past its events
 * that made it into the page, which are always a prefix of what it gave,
 * so an event read but cut is read again next time. A daemon that did not
 * answer keeps its part and is listed under `unavailable`, and one that had
 * no position yet keeps a null part, so the next read starts it at its
 * latest events rather than skipping what it queued meanwhile. A daemon
 * that started at its newest event, or at its latest events after such a
 * gap, is listed under `started`, and under `truncated` too when older
 * events precede the latest page and went unread. A note event also
 * holds `note`, its daemon-qualified handle for `note.get`. Every event's
 * ids are rewritten for its daemon, and its `cursor` is the gateway cursor
 * that resumes right after it.
 */
export function mergeEventPages(
  sources: readonly MergeSource[],
  filter: string,
  limit: number,
): MergedEvents {
  const parts = new Map<string, string | null>();

  const queues: {
    readonly source: MergeSource;
    readonly events: readonly Readonly<Record<string, unknown>>[];
    taken: number;
  }[] = [];

  const unavailable: string[] = [];
  const started: string[] = [];
  const truncated: string[] = [];

  for (const source of sources) {
    const key = `${source.daemon.name}.${source.daemon.incarnation}`;
    const page = source.page;

    if (page.kind === 'unavailable') {
      unavailable.push(source.daemon.name);

      if (source.before !== null) {
        parts.set(key, source.before.cursor);
      }
    } else if (page.kind === 'started') {
      started.push(source.daemon.name);
      parts.set(key, page.cursor);
    } else {
      if (source.unstarted !== undefined) {
        started.push(source.daemon.name);
      }

      if (source.unstarted?.olderUnread === true) {
        truncated.push(source.daemon.name);
      }

      // An empty page's cursor is where the daemon stands. Until one of a
      // page's events goes out, its daemon resumes right before the first
      // one, a position the daemon reads as concrete, unlike no cursor,
      // which it reads as its latest events.
      const [first] = page.events;
      const position = first === undefined ? page.cursor : buildPositionBefore(first);

      parts.set(key, position);
      queues.push({ source, events: page.events, taken: 0 });
    }
  }

  const events: Readonly<Record<string, unknown>>[] = [];

  while (events.length < limit) {
    const next = pickNextQueue(queues);

    if (next === null) {
      break;
    }

    const event = next.events[next.taken] ?? {};
    const daemon = next.source.daemon;

    next.taken++;

    if (typeof event['cursor'] === 'string') {
      parts.set(`${daemon.name}.${daemon.incarnation}`, event['cursor']);
    }

    const rewritten = buildRuledValue(event, EVENT_RULES, daemon);
    const handle = findNoteHandle(event, daemon);

    events.push({
      ...(isRecord(rewritten) ? rewritten : event),
      cursor: encodeGatewayCursor(filter, parts),
      ...(handle === null ? {} : { note: handle }),
    });
  }

  const more = queues.some(
    (queue) =>
      queue.taken < queue.events.length ||
      (queue.source.page.kind === 'read' && queue.source.page.more),
  );

  return {
    events,
    cursor: encodeGatewayCursor(filter, parts),
    more,
    unavailable,
    started,
    truncated,
  };
}

// A note event's handle for `note.get`: the daemon's own cursor of the
// event, which the daemon reads a note by, under the daemon's name and
// incarnation, kept apart from the merged feed cursor that replaces it.
function findNoteHandle(
  event: Readonly<Record<string, unknown>>,
  daemon: Pick<RegistryDaemon, 'name' | 'incarnation'>,
): string | null {
  const raw = event['cursor'];

  return event['kind'] === 'note' && typeof raw === 'string' ? buildGatewayID(daemon, raw) : null;
}

// The queue whose next event goes out next: the one with the earliest
// timestamp, ties going to the daemon that sorts first by name, or null
// once every queue is spent.
function pickNextQueue<
  T extends {
    readonly source: MergeSource;
    readonly events: readonly Readonly<Record<string, unknown>>[];
    readonly taken: number;
  },
>(queues: readonly T[]): T | null {
  let best: T | null = null;
  let bestAt = Number.POSITIVE_INFINITY;

  for (const queue of queues) {
    const head = queue.events[queue.taken];

    if (head === undefined) {
      continue;
    }

    const at = typeof head['at'] === 'number' ? head['at'] : Number.POSITIVE_INFINITY;

    if (
      best === null ||
      at < bestAt ||
      (at === bestAt && queue.source.daemon.name < best.source.daemon.name)
    ) {
      best = queue;
      bestAt = at;
    }
  }

  return best;
}

// The daemon cursor that resumes a read right before an event, from the
// event's own cursor. Throws for an event whose cursor is not a daemon's
// events cursor, which no daemon sends.
function buildPositionBefore(event: Readonly<Record<string, unknown>>): string {
  const raw = event['cursor'];
  const decoded = typeof raw === 'string' ? decodeCursor(raw) : null;

  if (decoded === null || decoded.kind !== 'events') {
    throw new Error('a daemon event holds no events cursor');
  }

  return encodeCursor({ kind: 'events', id: decoded.id - 1 });
}
