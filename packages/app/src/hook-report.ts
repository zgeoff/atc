import { isRecord } from '@atc/core';
import { normalizeHookEventName, readSessionEnv } from '@atc/protocol/session';
import { sendReport } from './shared/report';

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

// The variable Codex sets on each process a tool of a Codex thread starts.
// atc strips it from every session it starts, so a hook that sees it runs
// in a harness that a tool started inside the session.
const CODEX_TOOL_THREAD_KEY = 'CODEX_THREAD_ID';

export async function runHookReport(agent: string, io: HookReportIO = PROCESS_IO): Promise<void> {
  const session = readSessionEnv(process.env);
  const sock = session.socket;
  const atcId = session.sessionID;
  const nested = process.env[CODEX_TOOL_THREAD_KEY] !== undefined;

  // a nested harness shares the session's agent, so its report would read as
  // the session's own
  if (sock !== undefined && atcId !== undefined && !nested) {
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

    // the agent id lets the daemon tell a nested harness's report from the
    // session's own
    const line = `${JSON.stringify({ atcId, ...(agent === '' ? {} : { agent }), event, payload })}\n`;

    await sendReport(sock, line, 2000);
  }

  // always 0, so the hook never blocks the session it reports on
  io.exit(0);
}
