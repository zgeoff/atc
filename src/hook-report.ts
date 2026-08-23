import { normalizeHookEventName } from './agents/normalize-hook-event';
import { isRecord, sendReport } from './shared/report';

/**
 * Runs as a hook inside wrangled sessions. Reads the hook event from stdin
 * (Claude snake_case keys or Grok camelCase keys) and forwards a PascalCase
 * event name to the atc unix socket. Always exits 0 so it never blocks the
 * session it reports on.
 */
export async function runHookReport(): Promise<void> {
  const sock = process.env['ATC_SOCKET'];
  const atcId = process.env['ATC_SESSION_ID'];

  if (sock !== undefined && sock !== '' && atcId !== undefined && atcId !== '') {
    const raw = await new Response(Bun.stdin.stream()).text();

    let payload: Record<string, unknown> = {};

    try {
      const parsed: unknown = JSON.parse(raw);

      if (isRecord(parsed)) {
        payload = parsed;
      }
    } catch {}

    const rawName = payload['hook_event_name'] ?? payload['hookEventName'];
    const event = typeof rawName === 'string' ? normalizeHookEventName(rawName) : rawName;
    const line = `${JSON.stringify({ atcId, event, payload })}\n`;

    await sendReport(sock, line, 2000);
  }

  process.exit(0);
}
