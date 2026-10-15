import { isRecord } from '@atc/core/is-record';
import { systemClock } from '@atc/core/system-clock';
import type { Clock } from '@atc/core/system-clock';
import { formatToolError } from './format-tool-error';
import type { FleetCaller } from './types';

// The most note and answer text one events page carries, in UTF-8 bytes:
// as much as the daemon keeps of one note or one answer, so a page always
// has room for its first.
const TEXT_BUDGET_BYTES = 65_536;

// How long the reads of one page's texts may take in all. An events read
// can hold a call for about 35 seconds, and the HTTP server drops a call
// idle for 60, so the text reads finish well inside what is left.
const TEXT_READ_DEADLINE_MS = 10_000;

// What one text read gives its event: its text and whether that text is
// whole, or the error the read failed with.
type TextRead = Readonly<Record<string, unknown>>;

/**
 * An events page with the whole text of each of its notes, read through
 * `note.get`, and the whole answer of each message-answered event, read
 * through `answer.get`, by the page's own caller, so each read rides the
 * reach the page was read under. The reads run one at a time in page
 * order, so one text at most is ever in flight, under one deadline for
 * them all. A note or answered event gains the `text` and `complete` its
 * read returns, or `textError` when the read fails or outlasts the
 * deadline, and keeps its preview in `detail`. The page stops before the
 * first such event whose text would carry it past the budget, or whose read
 * would start after the deadline: it then holds the cursor of the last
 * event it keeps and `more` true, so the next read starts at that event.
 * Every other field of the page, such as a gateway's `unavailable` and
 * `truncated`, passes through unchanged. The deadline runs on `clock`, the
 * wall clock by default.
 */
export async function readEventTexts(
  caller: FleetCaller,
  page: Readonly<Record<string, unknown>>,
  deadlineMs: number = TEXT_READ_DEADLINE_MS,
  clock: Clock = systemClock,
): Promise<Readonly<Record<string, unknown>>> {
  const raw: unknown = page['events'];
  const events = Array.isArray(raw) ? raw.filter((event) => isRecord(event)) : [];
  const endsAt = clock.now() + deadlineMs;
  const timeout = Promise.withResolvers<TextRead>();

  const cancel = clock.schedule(() => {
    timeout.resolve({
      textError: `timeout: the text did not arrive within ${deadlineMs} ms`,
    });
  }, deadlineMs);

  const read = await readPageTexts(caller, page, events, endsAt, timeout.promise, clock);

  cancel();

  return read;
}

// The page with its note and answer texts read, one at a time, until the
// budget or the deadline at `endsAt` on `clock` stops it. A read still out
// when `timeout` settles gives way to the timeout it settles with.
async function readPageTexts(
  caller: FleetCaller,
  page: Readonly<Record<string, unknown>>,
  events: readonly Readonly<Record<string, unknown>>[],
  endsAt: number,
  timeout: Readonly<Promise<TextRead>>,
  clock: Clock,
): Promise<Readonly<Record<string, unknown>>> {
  const kept: Readonly<Record<string, unknown>>[] = [];
  let used = 0;

  for (const event of events) {
    const source = pickTextSource(event['kind']);

    if (source === null) {
      kept.push(event);
      continue;
    }

    const last = kept.at(-1);

    if (last !== undefined && clock.now() >= endsAt) {
      return { ...page, events: kept, cursor: last['cursor'], more: true };
    }

    const read = await Promise.race([readEventText(caller, event, source), timeout]);

    const bytes = typeof read['text'] === 'string' ? Buffer.byteLength(read['text']) : 0;

    if (last !== undefined && used + bytes > TEXT_BUDGET_BYTES) {
      return { ...page, events: kept, cursor: last['cursor'], more: true };
    }

    used += bytes;

    kept.push({ ...event, ...read });
  }

  return { ...page, events: kept };
}

// The read that holds an event's whole text and the event field that holds
// a gateway's handle for it, or null for an event with no text to read.
interface TextSource {
  readonly method: 'note.get' | 'answer.get';
  readonly param: 'note' | 'answer';
}

function pickTextSource(kind: unknown): TextSource | null {
  if (kind === 'note') {
    return { method: 'note.get', param: 'note' };
  }

  if (kind === 'message-answered') {
    return { method: 'answer.get', param: 'answer' };
  }

  return null;
}

// One event's whole text and whether it is complete, or the error its read
// failed with. The read takes the event's handle, which a gateway adds,
// else the event's own cursor, which a daemon reads the text by.
async function readEventText(
  caller: FleetCaller,
  event: Readonly<Record<string, unknown>>,
  source: TextSource,
): Promise<TextRead> {
  const raw = event[source.param];
  const handle = typeof raw === 'string' ? raw : event['cursor'];

  try {
    const read = await caller.sendRequest(source.method, { [source.param]: handle }, [
      source.method,
    ]);

    return { text: read['text'], complete: read['complete'] };
  } catch (error) {
    return { textError: formatToolError(error) };
  }
}
