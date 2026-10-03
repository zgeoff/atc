import { DaemonError } from '../protocol/daemon-error';
import type { DaemonFeature } from '../protocol/daemon-features';
import { decodeCursor } from '../protocol/decode-cursor';
import { encodeCursor } from '../protocol/encode-cursor';
import { isRecord } from '../shared/report';
import { buildEventsFilterHash } from './build-events-filter-hash';
import { buildGatewayError } from './build-gateway-error';
import type { DaemonCaller } from './daemon-caller';
import { GatewayError } from './gateway-error';
import { mergeEventPages } from './merge-event-pages';
import type { MergeSource } from './merge-event-pages';
import { parseGatewayID } from './parse-gateway-id';
import { planEventReads } from './plan-event-reads';
import type { EventReadStart } from './plan-event-reads';
import type { GatewayRegistry, RegistryDaemon } from './types';
import { waitForOutcome } from './wait-for-outcome';

interface FleetEventsDeps {
  readonly registry: GatewayRegistry;
  readonly getCaller: (name: string) => DaemonCaller;

  // How long each daemon may take to answer a read that does not wait.
  readonly timeoutMs: number;
}

// The daemon's own default and bounds for a page of events.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_WAIT_MS = 30_000;

/**
 * One `events.read` across the fleet: every daemon the plan asks is read in
 * parallel, each within the fan-out time, and the pages merge into one page
 * under a gateway cursor. A daemon that does not answer in time, or cannot
 * be reached, is listed under `unavailable` and keeps its position. A read
 * filtered to one session asks only its daemon, and that daemon's own
 * refusal, or its lack of the session filter, fails the call. With
 * `waitMs`, the daemons are first read without waiting; only when none has
 * an event does each wait, and the call returns as soon as one of them has
 * an event, the others keeping their positions.
 */
export async function readFleetEvents(
  deps: FleetEventsDeps,
  params: Readonly<Record<string, unknown>>,
  required: readonly DaemonFeature[],
  principal: string,
): Promise<Readonly<Record<string, unknown>>> {
  const rawSession = params['session'];
  const session = typeof rawSession === 'string' && rawSession !== '' ? rawSession : null;
  const owner = session === null ? null : parseGatewayID(session, deps.registry);

  if (session !== null && owner === null) {
    throw new DaemonError('no_such_session', `no session '${session}'`);
  }

  const filter = buildEventsFilterHash(session, null);
  const cursor = typeof params['cursor'] === 'string' ? params['cursor'] : null;
  const limit = toBounded(params['limit'], DEFAULT_LIMIT, 1, MAX_LIMIT);
  const waitMs = toBounded(params['waitMs'], 0, 0, MAX_WAIT_MS);
  const plan = planEventReads(cursor, filter, owner?.daemon.name ?? null, deps.registry);

  const requestIDs: [string, string][] =
    owner === null || session === null ? [] : [[owner.id, session]];

  const read: DaemonRead = {
    deps,
    required,
    principal,
    limit,
    sessionID: owner?.id ?? null,
    requestIDs: new Map(requestIDs),
  };

  const sources = await Promise.all(
    [...plan].map(([name, start]) => readDaemonSource(read, getDaemon(deps.registry, name), start)),
  );

  const first = mergeEventPages(sources, filter, limit);

  if (first.events.length > 0 || waitMs === 0) {
    return { ...first };
  }

  const waited = await waitForFirstEvents(read, sources, waitMs);

  return { ...mergeEventPages(waited, filter, limit) };
}

// What every daemon read of one call shares.
interface DaemonRead {
  readonly deps: FleetEventsDeps;
  readonly required: readonly DaemonFeature[];
  readonly principal: string;
  readonly limit: number;

  // The daemon's own id of the session a filtered read asks about.
  readonly sessionID: string | null;
  readonly requestIDs: ReadonlyMap<string, string>;
}

function getDaemon(registry: GatewayRegistry, name: string): RegistryDaemon {
  const daemon = registry.daemons.get(name);

  if (daemon === undefined) {
    throw new Error(`no daemon '${name}' in the registry`);
  }

  return daemon;
}

// One daemon's part of the merge, from where the plan starts it. Only a
// filtered read's daemon fails the call, and only with its own refusal or
// a missing feature; any other failure is a daemon that is unavailable.
async function readDaemonSource(
  read: DaemonRead,
  daemon: RegistryDaemon,
  start: EventReadStart,
): Promise<MergeSource> {
  const outcome = await waitForOutcome(readDaemonPart(read, daemon, start), read.deps.timeoutMs);

  if (outcome.kind === 'answered') {
    return outcome.value;
  }

  const error = outcome.kind === 'failed' ? outcome.error : null;

  if (read.sessionID !== null && error instanceof DaemonError) {
    throw buildGatewayError(error, daemon, read.requestIDs);
  }

  if (
    read.sessionID !== null &&
    error instanceof GatewayError &&
    error.code === 'daemon_outdated'
  ) {
    throw error;
  }

  const before = start.kind === 'after' ? { cursor: start.cursor } : null;
  const unread = start.kind === 'latest' ? { cursor: null } : before;

  return { daemon, before: unread, page: { kind: 'unavailable' } };
}

async function readDaemonPart(
  read: DaemonRead,
  daemon: RegistryDaemon,
  start: EventReadStart,
): Promise<MergeSource> {
  if (start.kind === 'newest') {
    const newest = await sendEventsRead(read, daemon, { limit: 1 });

    return { daemon, before: null, page: { kind: 'started', cursor: newest.cursor } };
  }

  if (start.kind === 'after') {
    const page = await sendEventsRead(read, daemon, {
      limit: read.limit,
      ...(start.cursor === null ? {} : { cursor: start.cursor }),
    });

    return { daemon, before: { cursor: start.cursor }, page };
  }

  const page = await sendEventsRead(read, daemon, { limit: read.limit });
  const olderUnread = await hasOlderEvents(read, daemon, page.events);

  return { daemon, before: { cursor: null }, page, unstarted: { olderUnread } };
}

// Whether the daemon holds an event older than the first of a page of its
// latest events, read as the first event after the start of its trail.
async function hasOlderEvents(
  read: DaemonRead,
  daemon: RegistryDaemon,
  events: readonly Readonly<Record<string, unknown>>[],
): Promise<boolean> {
  const [first] = events;
  const firstID = first === undefined ? null : findEventID(first);

  if (firstID === null) {
    return false;
  }

  const oldest = await sendEventsRead(read, daemon, {
    limit: 1,
    cursor: encodeCursor({ kind: 'events', id: 0 }),
  });

  const [oldestEvent] = oldest.events;
  const oldestID = oldestEvent === undefined ? null : findEventID(oldestEvent);

  return oldestID !== null && oldestID < firstID;
}

function findEventID(event: Readonly<Record<string, unknown>>): number | null {
  const raw = event['cursor'];
  const decoded = typeof raw === 'string' ? decodeCursor(raw) : null;

  return decoded !== null && decoded.kind === 'events' ? decoded.id : null;
}

// One events.read to one daemon as the call's principal, with the
// session filter when the read has one.
async function sendEventsRead(
  read: DaemonRead,
  daemon: RegistryDaemon,
  params: Readonly<Record<string, unknown>>,
): Promise<{
  readonly kind: 'read';
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly cursor: string;
  readonly more: boolean;
}> {
  const answer = await read.deps
    .getCaller(daemon.name)
    .sendRequest(
      'events.read',
      { ...params, ...(read.sessionID === null ? {} : { session: read.sessionID }) },
      read.principal,
      read.required,
    );

  const rawEvents: unknown = answer['events'];
  const events = Array.isArray(rawEvents) ? rawEvents.filter((event) => isRecord(event)) : [];

  return {
    kind: 'read',
    events,
    cursor: typeof answer['cursor'] === 'string' ? answer['cursor'] : '',
    more: answer['more'] === true,
  };
}

// Reads again, waiting, each daemon whose page came back empty, and settles
// once one of them answers with an event or all of them have answered. A
// daemon still waiting then keeps the empty page it gave before.
async function waitForFirstEvents(
  read: DaemonRead,
  sources: readonly MergeSource[],
  waitMs: number,
): Promise<readonly MergeSource[]> {
  const waited = new Map<MergeSource, MergeSource>();

  const firstEvents = Promise.withResolvers<void>();

  const reads = sources.map(async (source) => {
    if (source.page.kind !== 'read') {
      return;
    }

    const outcome = await waitForOutcome(
      sendEventsRead(read, getDaemon(read.deps.registry, source.daemon.name), {
        limit: read.limit,
        waitMs,
        cursor: source.page.cursor,
      }),
      read.deps.timeoutMs + waitMs,
    );

    if (outcome.kind === 'answered') {
      waited.set(source, { ...source, page: outcome.value });
    }

    if (outcome.kind === 'answered' && outcome.value.events.length > 0) {
      firstEvents.resolve();
    }
  });

  await Promise.race([firstEvents.promise, Promise.all(reads)]);

  return sources.map((source) => waited.get(source) ?? source);
}

function toBounded(value: unknown, fallback: number, min: number, max: number): number {
  const given = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;

  return Math.min(Math.max(given, min), max);
}
