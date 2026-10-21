import { isRecord } from '@atc/core';
import { decodeCursor, encodeCursor } from '@atc/protocol';
import { match } from 'ts-pattern';
import { buildGatewayID } from './build-gateway-id';
import { buildRuledValue } from './build-ruled-value';
import { encodeGatewayCursor } from './encode-gateway-cursor';
import { ID_RULES } from './id-rules';
import type { IDRule } from './id-rules';
import type { RegistryDaemon } from './types';

type DaemonEventPage =
  | {
      readonly kind: 'read';
      readonly events: readonly Readonly<Record<string, unknown>>[];
      readonly cursor: string;
      readonly more: boolean;
    }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'started'; readonly cursor: string };

export interface MergeSource {
  readonly daemon: Pick<RegistryDaemon, 'name' | 'incarnation'>;

  // null for a daemon the cursor left out, a null cursor for a read of its latest events
  readonly before: { readonly cursor: string | null } | null;
  readonly page: DaemonEventPage;

  // set for a latest page of a daemon that has not answered since the cursor started
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

const EVENT_PREFIX = 'events[].';

// The id fields of one event, relative to the event: the events read's
// rules under each event, less the event's cursor, which the merge rebuilds.
const EVENT_RULES: ReadonlyMap<string, IDRule> = new Map(
  [...(ID_RULES['events.read'] ?? [])].flatMap(([path, rule]) =>
    path.startsWith(EVENT_PREFIX) && rule !== 'cursor'
      ? [[path.slice(EVENT_PREFIX.length), rule] as const]
      : [],
  ),
);

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

    match(source.page)
      .with({ kind: 'unavailable' }, () => {
        unavailable.push(source.daemon.name);

        if (source.before !== null) {
          parts.set(key, source.before.cursor);
        }
      })
      .with({ kind: 'started' }, (page) => {
        started.push(source.daemon.name);
        parts.set(key, page.cursor);
      })
      .with({ kind: 'read' }, (page) => {
        if (source.unstarted !== undefined) {
          started.push(source.daemon.name);
        }

        if (source.unstarted?.olderUnread === true) {
          truncated.push(source.daemon.name);
        }

        // until one of a page's events goes out, its daemon resumes right before the first one,
        // a concrete position, since a daemon reads no cursor as its latest events
        const [first] = page.events;
        const position = first === undefined ? page.cursor : buildPositionBefore(first);

        parts.set(key, position);
        queues.push({ source, events: page.events, taken: 0 });
      })
      .exhaustive();
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
    const handle = findTextHandle(event, daemon);

    events.push({
      ...(isRecord(rewritten) ? rewritten : event),
      cursor: encodeGatewayCursor(filter, parts),
      ...handle,
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

// the daemon's own cursor of the event, which the daemon reads the text by, kept apart from
// the merged feed cursor that replaces it
function findTextHandle(
  event: Readonly<Record<string, unknown>>,
  daemon: Pick<RegistryDaemon, 'name' | 'incarnation'>,
): Readonly<Record<string, string>> {
  const raw = event['cursor'];

  if (typeof raw !== 'string') {
    return {};
  }

  if (event['kind'] === 'note') {
    return { note: buildGatewayID(daemon, raw) };
  }

  if (event['kind'] === 'message-answered') {
    return { answer: buildGatewayID(daemon, raw) };
  }

  return {};
}
