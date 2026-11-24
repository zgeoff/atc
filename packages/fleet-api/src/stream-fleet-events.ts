import type { Principal } from '@atc/protocol';
import { withEventMeta } from '@orpc/server';
import type { Clock } from '@zgeoff/std';
import { z } from 'zod';
import { buildFleetError } from './build-fleet-error';
import { toFleetError } from './to-fleet-error';
import type { FleetCaller } from './types';

export interface FleetEventStreamOptions {
  readonly caller: FleetCaller;
  readonly clock: Pick<Clock, 'sleep'>;

  // Checks one item against the stream's contract and returns an error message when it fails.
  readonly findItemProblem: (item: unknown) => string | null;
  readonly principal: Principal | undefined;
  readonly cursor: string | undefined;
  readonly lastEventID: string | undefined;
  readonly signal: AbortSignal | undefined;
}

// A gateway skips its wait when no daemon it reaches can wait, so a page that holds no event
// reads again after this long.
const OUTAGE_RETRY_MS = 2000;
const ENDED = Symbol('ended');
const EMPTY_LISTS = '[[],[],[]]';

// The merged event trail as an item stream. It reads one page at a time, as its caller, and reads
// the next only after the consumer took the last item of the last page.
export async function* streamFleetEvents(
  opts: FleetEventStreamOptions,
): AsyncGenerator<unknown, void, undefined> {
  let position = opts.lastEventID ?? opts.cursor ?? null;
  let isDiscarding = position === null;
  let lastLists = EMPTY_LISTS;

  while (opts.signal?.aborted !== true) {
    const read = await readPage(opts, position, isDiscarding);

    if (read === ENDED) {
      return;
    }

    position = read.cursor;

    if (!isDiscarding) {
      for (const event of read.events) {
        yield buildItem(opts, { kind: 'event', event }, event.cursor);
      }
    }

    isDiscarding &&= read.more;

    const lists = JSON.stringify([read.unavailable, read.started, read.truncated]);

    if (lists !== lastLists) {
      lastLists = lists;

      yield buildItem(
        opts,
        {
          kind: 'daemons',
          unavailable: read.unavailable,
          started: read.started,
          truncated: read.truncated,
        },
        read.cursor,
      );
    }

    if (read.events.length === 0 && read.unavailable.length > 0) {
      await opts.clock.sleep(OUTAGE_RETRY_MS, opts.signal);
    }
  }
}

const PAGE_EVENT = z.looseObject({ cursor: z.string() });

const PAGE_SCHEMA = z.object({
  events: z.array(PAGE_EVENT),
  cursor: z.string(),
  more: z.boolean(),
  unavailable: z.array(z.string()).default([]),
  started: z.array(z.string()).default([]),
  truncated: z.array(z.string()).default([]),
});

type Page = z.output<typeof PAGE_SCHEMA>;

const HEAD_LIMIT = 200;
const PAGE_LIMIT = 50;

// The daemon allows a trail read to wait at most 30 s for an event.
const WAIT_MS = 30_000;

async function readPage(
  opts: FleetEventStreamOptions,
  position: string | null,
  isDiscarding: boolean,
): Promise<Page | typeof ENDED> {
  const params =
    position === null
      ? { limit: HEAD_LIMIT }
      : {
          cursor: position,
          limit: isDiscarding ? HEAD_LIMIT : PAGE_LIMIT,
          ...(isDiscarding ? {} : { waitMs: WAIT_MS }),
        };

  const settled = settleRead(opts, params);

  const answer = await raceAbort(settled, opts.signal);

  if (answer === ENDED) {
    return ENDED;
  }

  if (!answer.ok) {
    throw toFleetError(answer.error);
  }

  const parsed = PAGE_SCHEMA.safeParse(answer.value);

  if (!parsed.success) {
    throw buildFleetError('internal', {
      message: `the answer to events.read does not match its contract: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    });
  }

  return parsed.data;
}

type SettledRead =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: unknown };

// A read that settles after the stream ended has no one to tell, so it never rejects.
async function settleRead(
  opts: FleetEventStreamOptions,
  params: Readonly<Record<string, unknown>>,
): Promise<SettledRead> {
  try {
    const value = await opts.caller.sendRequest('events.read', params, opts.principal);

    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

async function raceAbort(
  settled: Promise<SettledRead>,
  signal: AbortSignal | undefined,
): Promise<SettledRead | typeof ENDED> {
  if (signal === undefined) {
    return settled;
  }

  const aborted = Promise.withResolvers<typeof ENDED>();

  const onAbort = (): void => {
    aborted.resolve(ENDED);
  };

  signal.addEventListener('abort', onAbort, { once: true });

  try {
    return await Promise.race([settled, aborted.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function buildItem(opts: FleetEventStreamOptions, item: object, id: string): object {
  const problem = opts.findItemProblem(item);

  if (problem !== null) {
    throw buildFleetError('internal', {
      message: `an item of events.stream does not match its contract: ${problem}`,
    });
  }

  return withEventMeta(item, { id });
}
