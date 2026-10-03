import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendBridgeRequest } from './protocol/send-bridge-request';
import { sendReport } from './shared/report';
import { REPORT_KINDS } from './shared/report-kinds';

interface ReportOptions {
  readonly message: string;

  // Comma-separated ids of every message one turn answered, reported together.
  readonly messages: string;
  readonly label: string;

  // The turn whose final reply an `answered` report carries; empty when unknown.
  readonly turn: string;
}

/**
 * Runs inside wrangled sessions: reads stdin verbatim and forwards it to the
 * atc socket as a Report envelope of the given kind. An `answered` report
 * carries stdin as the final reply of the turn that carried the given
 * message, or every given message at once, plus that turn's id when one is
 * given; a `note` carries
 * it as text for the user under the given label, `progress` when none is
 * given. Inside a remote host it goes to the session bridge instead. Always
 * exits 0 so it never blocks the session it reports on.
 */
export async function runReport(kind: string, options: ReportOptions): Promise<void> {
  try {
    const sock = process.env['ATC_SOCKET'];
    const atcId = process.env['ATC_SESSION_ID'];

    if (
      sock !== undefined &&
      sock !== '' &&
      atcId !== undefined &&
      atcId !== '' &&
      REPORT_KINDS.some((known) => known === kind)
    ) {
      const stdin = await new Response(Bun.stdin.stream()).text();

      const payload = buildReportPayload(kind, options, stdin);

      if (payload !== null && process.env['ATC_BRIDGE'] === '1') {
        await sendBridgeReport(sock, process.env['ATC_OUTBOX'] ?? '', payload);
      } else if (payload !== null) {
        const line = `${JSON.stringify({ atcId, event: 'Report', payload })}\n`;

        await sendReport(sock, line, 2000);
      }
    }
  } catch {}

  process.exit(0);
}

// Inside a remote host, a report goes to the session bridge under an id of
// its own, and waits in the outbox until the bridge takes or refuses it, so
// the session's tap sends it again after a dropped connection. A resent
// report lands once, and a refused one is never resent.
async function sendBridgeReport(
  sock: string,
  outbox: string,
  payload: Readonly<Record<string, string | readonly string[]>>,
): Promise<void> {
  const reportID = randomUUID();
  const file = outbox === '' ? null : join(outbox, `${reportID}.json`);

  if (file !== null) {
    try {
      mkdirSync(outbox, { recursive: true });
      writeFileSync(file, JSON.stringify({ reportID, payload }));
    } catch {}
  }

  const answer = await sendBridgeRequest(sock, 'report', { reportID, payload }, 2000);

  const isFinal = answer?.['ok'] === true || answer?.['code'] === 'forbidden';

  if (isFinal && file !== null) {
    rmSync(file, { force: true });
  }
}

function buildReportPayload(
  kind: string,
  options: ReportOptions,
  stdin: string,
): Record<string, string | readonly string[]> | null {
  if (kind === 'answered') {
    const messages = options.messages.split(',').filter((id) => id !== '');
    const turn = options.turn === '' ? {} : { turn: options.turn };

    if (messages.length > 0) {
      return { kind, messages, answer: stdin, ...turn };
    }

    return options.message === ''
      ? null
      : { kind, message: options.message, answer: stdin, ...turn };
  }

  if (kind === 'note') {
    return stdin.trim() === ''
      ? null
      : { kind, label: options.label === '' ? 'progress' : options.label, text: stdin };
  }

  return null;
}
