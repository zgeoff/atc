import { isRecord, systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import { formatToolError } from './format-tool-error';
import type { FleetCaller } from './types';

// An events read can hold a call for about 35 seconds and the HTTP server drops a call idle
// for 60, so the text reads for one page must finish well inside the time left.
const TEXT_READ_DEADLINE_MS = 10_000;

type TextRead = Readonly<Record<string, unknown>>;

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

  const read = await readPageTexts(caller, {
    page,
    events,
    endsAt,
    timeout: timeout.promise,
    clock,
  });

  cancel();

  return read;
}

// The most note and answer text one events page carries, in UTF-8 bytes:
// as much as the daemon keeps of one note or one answer, so a page always
// has room for its first.
const TEXT_BUDGET_BYTES = 65_536;

interface ReadPageTextsOptions {
  readonly page: Readonly<Record<string, unknown>>;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly endsAt: number;
  readonly timeout: Readonly<Promise<TextRead>>;
  readonly clock: Clock;
}

async function readPageTexts(
  caller: FleetCaller,
  options: ReadPageTextsOptions,
): Promise<Readonly<Record<string, unknown>>> {
  const kept: Readonly<Record<string, unknown>>[] = [];
  let used = 0;

  for (const event of options.events) {
    const source = pickTextSource(event['kind']);

    if (source === null) {
      kept.push(event);
      continue;
    }

    const last = kept.at(-1);

    if (last !== undefined && options.clock.now() >= options.endsAt) {
      return { ...options.page, events: kept, cursor: last['cursor'], more: true };
    }

    const read = await Promise.race([readEventText(caller, event, source), options.timeout]);

    const bytes = typeof read['text'] === 'string' ? Buffer.byteLength(read['text']) : 0;

    if (last !== undefined && used + bytes > TEXT_BUDGET_BYTES) {
      return { ...options.page, events: kept, cursor: last['cursor'], more: true };
    }

    used += bytes;

    kept.push({ ...event, ...read });
  }

  return { ...options.page, events: kept };
}

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

// A gateway adds a handle to each event; a daemon adds none and reads text by the event's own
// cursor.
async function readEventText(
  caller: FleetCaller,
  event: Readonly<Record<string, unknown>>,
  source: TextSource,
): Promise<TextRead> {
  const raw = event[source.param];
  const handle = typeof raw === 'string' ? raw : event['cursor'];

  try {
    const read = await caller.sendRequest(source.method, { [source.param]: handle });

    return { text: read['text'], complete: read['complete'] };
  } catch (error) {
    return { textError: formatToolError(error) };
  }
}
