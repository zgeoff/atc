import { normalizeHookEventName } from './agents/normalize-hook-event';
import { isRecord, sendReport } from './shared/report';

// Where the reporter reads its event and how it exits: stdin and the
// process by default.
interface HookReportIO {
  readonly readStdin: () => Promise<string>;
  readonly exit: (code: number) => void;
}

const PROCESS_IO: HookReportIO = {
  readStdin: () => new Response(Bun.stdin.stream()).text(),
  exit: (code) => {
    process.exit(code);
  },
};

/**
 * Runs as a hook inside wrangled sessions. Reads the hook event from stdin
 * (Claude snake_case keys or Grok camelCase keys) and forwards a PascalCase
 * event name to the atc unix socket, with the agent id the hook command
 * gave it, so the daemon can tell a nested harness's report from the
 * session's own. Always exits 0 so it never blocks the session it reports
 * on.
 */
export async function runHookReport(agent: string, io: HookReportIO = PROCESS_IO): Promise<void> {
  const sock = process.env['ATC_SOCKET'];
  const atcId = process.env['ATC_SESSION_ID'];

  if (sock !== undefined && sock !== '' && atcId !== undefined && atcId !== '') {
    const raw = await io.readStdin();

    let payload: Record<string, unknown> = {};

    try {
      const parsed: unknown = JSON.parse(raw);

      if (isRecord(parsed)) {
        payload = parsed;
      }
    } catch {}

    const rawName = payload['hook_event_name'] ?? payload['hookEventName'];
    const event = typeof rawName === 'string' ? normalizeHookEventName(rawName) : rawName;
    const line = `${JSON.stringify({ atcId, ...(agent === '' ? {} : { agent }), event, payload })}\n`;

    await sendReport(sock, line, 2000);
  }

  io.exit(0);
}
