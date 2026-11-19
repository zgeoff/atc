import { isRecord } from '@atc/core';
import { normalizeHookEventName, readSessionEnv } from '@atc/protocol/session';
import { sendReport } from './send-report';

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

// Codex sets this variable on every process a tool of its thread starts. atc strips it from
// its own sessions, so seeing it means a tool started this hook inside the session.
const CODEX_TOOL_THREAD_KEY = 'CODEX_THREAD_ID';
const REPORT_TIMEOUT_MS = 2000;

// The daemon may hold a remote session's start report up to 10 s. Claude Code starts the
// first turn only after the hook ends, so wait 25 s.
const SESSION_START_EVENT = 'SessionStart';
const SESSION_START_REPORT_TIMEOUT_MS = 25_000;

export async function runHookReport(agent: string, io: HookReportIO = PROCESS_IO): Promise<void> {
  const session = readSessionEnv(process.env);
  const sock = session.socket;
  const atcId = session.sessionID;
  const nested = process.env[CODEX_TOOL_THREAD_KEY] !== undefined;

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
    const line = `${JSON.stringify({ atcId, ...(agent === '' ? {} : { agent }), event, payload })}\n`;
    const isStart = event === SESSION_START_EVENT;
    const timeoutMs = isStart ? SESSION_START_REPORT_TIMEOUT_MS : REPORT_TIMEOUT_MS;
    const end = isStart ? 'wait' : 'close';

    await sendReport(sock, line, timeoutMs, end);
  }

  io.exit(0);
}
