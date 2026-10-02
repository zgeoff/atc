import { sendReport } from './shared/report';

const REPORT_KINDS = new Set(['answered']);

/**
 * Runs inside wrangled sessions: reads the final text from stdin verbatim
 * and forwards it to the atc socket as a Report envelope of the given kind
 * for the given message. Always exits 0 so it never blocks the session it
 * reports on.
 */
export async function runReport(kind: string, message: string): Promise<void> {
  try {
    const sock = process.env['ATC_SOCKET'];
    const atcId = process.env['ATC_SESSION_ID'];

    if (
      sock !== undefined &&
      sock !== '' &&
      atcId !== undefined &&
      atcId !== '' &&
      REPORT_KINDS.has(kind) &&
      message !== ''
    ) {
      const answer = await new Response(Bun.stdin.stream()).text();

      const line = `${JSON.stringify({ atcId, event: 'Report', payload: { kind, message, answer } })}\n`;

      await sendReport(sock, line, 2000);
    }
  } catch {}

  process.exit(0);
}
