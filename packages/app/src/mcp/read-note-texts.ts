import { isRecord } from '../shared/report';
import { systemClock } from '../shared/system-clock';
import type { Clock } from '../shared/system-clock';
import type { FleetCaller } from './types';

// The most note text one events page carries, in UTF-8 bytes: as much as
// the daemon keeps of one note, so a page always has room for its first.
const NOTE_TEXT_BUDGET_BYTES = 65_536;

// How long the reads of one page's note texts may take in all. An events
// read can hold a call for about 35 seconds, and the HTTP server drops a
// call idle for 60, so the note reads finish well inside what is left.
const NOTE_READ_DEADLINE_MS = 10_000;

// What one note read gives its event: its text and whether that text is
// whole, or the error the read failed with.
type NoteRead = Readonly<Record<string, unknown>>;

/**
 * An events page with the whole text of each of its notes, read through
 * `note.get` by the page's own caller, so each read rides the reach the
 * page was read under. The reads run one at a time in page order, so one
 * note text at most is ever in flight, under one deadline for them all.
 * A note event gains the `text` and `complete` its read returns, or
 * `textError` when the read fails or outlasts the deadline, and keeps its
 * preview in `detail`. The page stops before the first note whose text
 * would carry it past the budget, or whose read would start after the
 * deadline: it then holds the cursor of the last event it keeps and `more`
 * true, so the next read starts at that note. Every other field of the
 * page, such as a gateway's `unavailable` and `truncated`, passes through
 * unchanged. The deadline runs on `clock`, the wall clock by default.
 */
export async function readNoteTexts(
  caller: FleetCaller,
  page: Readonly<Record<string, unknown>>,
  deadlineMs: number = NOTE_READ_DEADLINE_MS,
  clock: Clock = systemClock,
): Promise<Readonly<Record<string, unknown>>> {
  const raw: unknown = page['events'];
  const events = Array.isArray(raw) ? raw.filter((event) => isRecord(event)) : [];
  const endsAt = clock.now() + deadlineMs;
  const timeout = Promise.withResolvers<NoteRead>();

  const cancel = clock.schedule(() => {
    timeout.resolve({
      textError: `timeout: the note text did not arrive within ${deadlineMs} ms`,
    });
  }, deadlineMs);

  const read = await readPageNotes(caller, page, events, endsAt, timeout.promise, clock);

  cancel();

  return read;
}

// The page with its notes read, one at a time, until the budget or the
// deadline at `endsAt` on `clock` stops it. A read still out when `timeout` settles
// gives way to the timeout it settles with.
async function readPageNotes(
  caller: FleetCaller,
  page: Readonly<Record<string, unknown>>,
  events: readonly Readonly<Record<string, unknown>>[],
  endsAt: number,
  timeout: Readonly<Promise<NoteRead>>,
  clock: Clock,
): Promise<Readonly<Record<string, unknown>>> {
  const kept: Readonly<Record<string, unknown>>[] = [];
  let used = 0;

  for (const event of events) {
    if (event['kind'] !== 'note') {
      kept.push(event);
      continue;
    }

    const last = kept.at(-1);

    if (last !== undefined && clock.now() >= endsAt) {
      return { ...page, events: kept, cursor: last['cursor'], more: true };
    }

    const read = await Promise.race([readNoteText(caller, event), timeout]);

    const bytes = typeof read['text'] === 'string' ? Buffer.byteLength(read['text']) : 0;

    if (last !== undefined && used + bytes > NOTE_TEXT_BUDGET_BYTES) {
      return { ...page, events: kept, cursor: last['cursor'], more: true };
    }

    used += bytes;

    kept.push({ ...event, ...read });
  }

  return { ...page, events: kept };
}

// One note event's whole text and whether it is complete, or the error
// its read failed with. The read takes the event's note handle, which a
// gateway adds, else the event's own cursor, which a daemon reads a note
// by.
async function readNoteText(
  caller: FleetCaller,
  event: Readonly<Record<string, unknown>>,
): Promise<NoteRead> {
  const handle = typeof event['note'] === 'string' ? event['note'] : event['cursor'];

  try {
    const note = await caller.sendRequest('note.get', { note: handle }, ['note.get']);

    return { text: note['text'], complete: note['complete'] };
  } catch (error) {
    return { textError: formatReadError(error) };
  }
}

// An error with a lowercase protocol-style code reads as `<code>: <message>`,
// as a failed tool call does.
function formatReadError(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[a-z][a-z_]*$/.test(error.code)
  ) {
    return `${error.code}: ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}
