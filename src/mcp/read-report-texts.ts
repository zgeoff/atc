import { isRecord } from '../shared/report';
import type { FleetCaller } from './types';

// The most report text one events page carries, in UTF-8 bytes: as much as
// the daemon keeps of one report, so a page always has room for its first.
const REPORT_TEXT_BUDGET_BYTES = 65_536;

/**
 * An events page with the whole text of each of its reports, read one at a
 * time through `report.get` by the page's own caller, so each read rides
 * the reach the page was read under. A report event gains the `text` and
 * `complete` that read returns, or `textError` when the read fails, and
 * keeps its preview in `detail`. The page stops before the first report
 * whose text would carry it past the budget: it then holds the cursor of
 * the last event it keeps and `more` true, so the next read starts at that
 * report. Every other field of the page, such as a gateway's `unavailable`
 * and `truncated`, passes through unchanged.
 */
export async function readReportTexts(
  caller: FleetCaller,
  page: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  const raw: unknown = page['events'];
  const events = Array.isArray(raw) ? raw.filter((event) => isRecord(event)) : [];
  const kept: Readonly<Record<string, unknown>>[] = [];
  let used = 0;

  for (const event of events) {
    if (event['kind'] !== 'report') {
      kept.push(event);
      continue;
    }

    const read = await readReportText(caller, event);

    const bytes = typeof read['text'] === 'string' ? Buffer.byteLength(read['text']) : 0;
    const last = kept.at(-1);

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
): Promise<Readonly<Record<string, unknown>>> {
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
