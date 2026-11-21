import { isRecord } from '@atc/core';
import type { Principal } from '@atc/protocol';
import { decodeCursor, encodeCursor } from '@atc/protocol';
import { AtcError } from '@atcx/contract/light';
import type { Clock } from '@zgeoff/std';
import type { GatewayDaemonCaller } from '../daemons/create-gateway-daemon-caller';
import { waitForOutcome } from '../daemons/wait-for-outcome';
import { buildGatewayError } from '../ids/build-gateway-error';
import { parseGatewayID } from '../ids/parse-gateway-id';
import type { GatewayRegistry, RegistryDaemon } from '../types';
import { buildEventsFilterHash } from './build-events-filter-hash';
import { mergeEventPages } from './merge-event-pages';
import type { MergeSource } from './merge-event-pages';
import { planEventReads } from './plan-event-reads';
import type { EventReadStart } from './plan-event-reads';

interface FleetEventsDeps {
  readonly registry: GatewayRegistry;
  readonly getCaller: (name: string) => GatewayDaemonCaller;

  readonly timeoutMs: number;

  readonly clock: Pick<Clock, 'now' | 'schedule'>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_WAIT_MS = 30_000;

interface DaemonRead {
  readonly deps: FleetEventsDeps;
  readonly principal: Principal;
  readonly limit: number;

  readonly sessionID: string | null;
  readonly requestIDs: ReadonlyMap<string, string>;
}

export async function readFleetEvents(
  deps: FleetEventsDeps,
  params: Readonly<Record<string, unknown>>,
  principal: Principal,
): Promise<Readonly<Record<string, unknown>>> {
  const rawSession = params['session'];
  const session = typeof rawSession === 'string' && rawSession !== '' ? rawSession : null;
  const owner = session === null ? null : parseGatewayID(session, deps.registry);

  if (session !== null && owner === null) {
    throw new AtcError('no_such_session', `no session '${session}'`);
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

function toBounded(value: unknown, fallback: number, min: number, max: number): number {
  const given = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;

  return Math.min(Math.max(given, min), max);
}

async function readDaemonSource(
  read: DaemonRead,
  daemon: RegistryDaemon,
  start: EventReadStart,
): Promise<MergeSource> {
  const outcome = await waitForOutcome(
    readDaemonPart(read, daemon, start),
    read.deps.timeoutMs,
    read.deps.clock,
  );

  if (outcome.kind === 'answered') {
    return outcome.value;
  }

  const error = outcome.kind === 'failed' ? outcome.error : null;

  if (read.sessionID !== null && error instanceof AtcError) {
    throw buildGatewayError(error, daemon, read.requestIDs);
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
  const olderUnread = await probeOlderEvents(read, daemon, page.events);

  return { daemon, before: { cursor: null }, page, unstarted: { olderUnread } };
}

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

async function probeOlderEvents(
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

function getDaemon(registry: GatewayRegistry, name: string): RegistryDaemon {
  const daemon = registry.daemons.get(name);

  if (daemon === undefined) {
    throw new Error(`no daemon '${name}' in the registry`);
  }

  return daemon;
}

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
      read.deps.clock,
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
