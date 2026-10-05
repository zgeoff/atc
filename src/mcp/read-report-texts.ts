import { isRecord } from '../shared/report';
import type { FleetCaller } from './types';

// The most report text one events page carries, in UTF-8 bytes: as much as
// the daemon keeps of one report, so a page always has room for its first.
const REPORT_TEXT_BUDGET_BYTES = 65_536;

// How long the reads of one page's report texts may take in all. An events
// read can hold a call for about 35 seconds, and the HTTP server drops a
// call idle for 60, so the report reads finish well inside what is left.
const REPORT_READ_DEADLINE_MS = 10_000;

// What one report read gives its event: its text and whether that text is
// whole, or the error the read failed with.
type ReportRead = Readonly<Record<string, unknown>>;

/**
 * An events page with the whole text of each of its reports, read through
 * `report.get` by the page's own caller, so each read rides the reach the
 * page was read under. The reads run one at a time in page order, so one
 * report text at most is ever in flight, under one deadline for them all.
 * A report event gains the `text` and `complete` its read returns, or
 * `textError` when the read fails or outlasts the deadline, and keeps its
 * preview in `detail`. The page stops before the first report whose text
 * would carry it past the budget, or whose read would start after the
 * deadline: it then holds the cursor of the last event it keeps and `more`
 * true, so the next read starts at that report. Every other field of the
 * page, such as a gateway's `unavailable` and `truncated`, passes through
 * unchanged.
 */
export async function readReportTexts(
  caller: FleetCaller,
  page: Readonly<Record<string, unknown>>,
  deadlineMs: number = REPORT_READ_DEADLINE_MS,
): Promise<Readonly<Record<string, unknown>>> {
  const raw: unknown = page['events'];
  const events = Array.isArray(raw) ? raw.filter((event) => isRecord(event)) : [];
  const endsAt = Date.now() + deadlineMs;
  const timeout = Promise.withResolvers<ReportRead>();

  const timer = setTimeout(() => {
    timeout.resolve({
      textError: `timeout: the report text did not arrive within ${deadlineMs} ms`,
    });
  }, deadlineMs);

  const read = await readPageReports(caller, page, events, endsAt, timeout.promise);

  clearTimeout(timer);

  return read;
}

// The page with its reports read, one at a time, until the budget or the
// deadline at `endsAt` stops it. A read still out when `timeout` settles
// gives way to the timeout it settles with.
async function readPageReports(
  caller: FleetCaller,
  page: Readonly<Record<string, unknown>>,
  events: readonly Readonly<Record<string, unknown>>[],
  endsAt: number,
  timeout: Readonly<Promise<ReportRead>>,
): Promise<Readonly<Record<string, unknown>>> {
  const kept: Readonly<Record<string, unknown>>[] = [];
  let used = 0;

  for (const event of events) {
    if (event['kind'] !== 'report') {
      kept.push(event);
      continue;
    }

    const last = kept.at(-1);

    if (last !== undefined && Date.now() >= endsAt) {
      return { ...page, events: kept, cursor: last['cursor'], more: true };
    }

    const read = await Promise.race([readReportText(caller, event), timeout]);

    const bytes = typeof read['text'] === 'string' ? Buffer.byteLength(read['text']) : 0;

    if (last !== undefined && used + bytes > REPORT_TEXT_BUDGET_BYTES) {
      return { ...page, events: kept, cursor: last['cursor'], more: true };
    }

    used += bytes;

    kept.push({ ...event, ...read });
  }

  return { ...page, events: kept };
}

// One report event's whole text and whether it is complete, or the error
// its read failed with. The read takes the event's report handle, which a
// gateway adds, else the event's own cursor, which a daemon reads a report
// by.
async function readReportText(
  caller: FleetCaller,
  event: Readonly<Record<string, unknown>>,
): Promise<ReportRead> {
  const handle = typeof event['report'] === 'string' ? event['report'] : event['cursor'];

  try {
    const report = await caller.sendRequest('report.get', { report: handle }, ['report.get']);

    return { text: report['text'], complete: report['complete'] };
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
