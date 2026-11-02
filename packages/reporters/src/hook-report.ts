import { isRecord } from '@atc/core';
import { normalizeHookEventName, readSessionEnv } from '@atc/protocol/session';
import { sendReport } from './send-report';

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
const REPORT_TIMEOUT_MS = 2000;

// The daemon holds a remote session's start report until the session's bridge tap attaches or
// its mod is written again, which takes up to its 10 s start wait and the write; Claude Code
// starts the first turn only once the report's hook ends, so the reporter waits that long.
const SESSION_START_EVENT = 'SessionStart';
const SESSION_START_REPORT_TIMEOUT_MS = 25_000;

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
    const isStart = event === SESSION_START_EVENT;
    const timeoutMs = isStart ? SESSION_START_REPORT_TIMEOUT_MS : REPORT_TIMEOUT_MS;
    const end = isStart ? 'wait' : 'close';

    await sendReport(sock, line, timeoutMs, end);
  }

  // always 0, so the hook never blocks the session it reports on
  io.exit(0);
}
