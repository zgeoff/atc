import { isRecord } from '../shared/report';
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
 * stood before the read (absent for a daemon the cursor left out), and
 * what it gave.
 */
export interface MergeSource {
  readonly daemon: Pick<RegistryDaemon, 'name' | 'incarnation'>;
  readonly before: { readonly cursor: string | null } | null;
  readonly page: DaemonEventPage;
}

interface MergedEvents {
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly cursor: string;
  readonly more: boolean;
  readonly unavailable: readonly string[];
  readonly started: readonly string[];
}

// The id fields of one event, relative to the event.
const EVENT_RULES: ReadonlyMap<string, IDRule> = new Map([
  ['session', 'id'],
  ['message', 'id'],
  ['parent', 'id'],
  ['report', 'id'],
]);

/**
 * Merges the daemons' pages of one events read into one page of at most
 * `limit` events. Each daemon's events keep their own order, and daemons
 * interleave by timestamp as a best effort, since daemon clocks can skew.
 * Each daemon's part of the returned cursor advances only past its events
 * that made it into the page, which are always a prefix of what it gave,
 * so an event read but cut is read again next time. A daemon that did not
 * answer keeps its part and is listed under `unavailable`; a daemon that
 * started at its newest event is listed under `started`. Every event's
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
      // An empty page's cursor is where the daemon stands; a page whose
      // events are cut below resumes from where it stood before the read.
      const position = page.events.length === 0 ? page.cursor : (source.before?.cursor ?? null);

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

    events.push({
      ...(isRecord(rewritten) ? rewritten : event),
      cursor: encodeGatewayCursor(filter, parts),
    });
  }

  const more = queues.some(
    (queue) =>
      queue.taken < queue.events.length ||
      (queue.source.page.kind === 'read' && queue.source.page.more),
  );

  return { events, cursor: encodeGatewayCursor(filter, parts), more, unavailable, started };
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
