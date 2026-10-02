import { sendReport } from './shared/report';
import { REPORT_KINDS } from './shared/report-kinds';

interface ReportOptions {
  readonly message: string;
  readonly label: string;

  // The turn whose final reply an `answered` report carries; empty when unknown.
  readonly turn: string;
}

/**
 * Runs inside wrangled sessions: reads stdin verbatim and forwards it to the
 * atc socket as a Report envelope of the given kind. An `answered` report
 * carries stdin as the final reply of the turn that carried the given
 * message, plus that turn's id when one is given; a `note` carries
 * it as text for the user under the given label, `progress` when none is
 * given. Always exits 0 so it never blocks the session it reports on.
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

      if (payload !== null) {
        const line = `${JSON.stringify({ atcId, event: 'Report', payload })}\n`;

        await sendReport(sock, line, 2000);
      }
    }
  } catch {}

  process.exit(0);
}

function buildReportPayload(
  kind: string,
  options: ReportOptions,
  stdin: string,
): Record<string, string> | null {
  if (kind === 'answered') {
    if (options.message === '') {
      return null;
    }

    return {
      kind,
      message: options.message,
      answer: stdin,
      ...(options.turn === '' ? {} : { turn: options.turn }),
    };
  }

  if (kind === 'note') {
    return stdin.trim() === ''
      ? null
      : { kind, label: options.label === '' ? 'progress' : options.label, text: stdin };
  }

  return null;
}
