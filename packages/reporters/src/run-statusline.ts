import { readFileSync } from 'node:fs';
import { loadClaudeStatusLine } from '@atc/config/claude-statusline';
import { statusFile } from '@atc/config/host';
import { isRecord } from '@atc/core';
import { readSessionEnv, sendBridgeRequest } from '@atc/protocol/session';
import { sendReport } from './send-report';

// Where the statusline reads its payload and the fleet's status, how it runs
// the user's own statusline, where it prints, and how it exits: the process
// by default.
interface StatuslineIO {
  readonly readStdin: () => Promise<string>;

  // Throws when the status file is missing or unreadable.
  readonly readStatusFile: () => string;

  // Runs a command with the payload as its stdin and resolves with its stdout.
  readonly runChained: (command: string, stdin: string) => Promise<string>;
  readonly print: (line: string) => void;
  readonly exit: (code: number) => void;
}

const PROCESS_IO: StatuslineIO = {
  readStdin: () => new Response(Bun.stdin.stream()).text(),
  readStatusFile: () => readFileSync(statusFile, 'utf8'),
  runChained: runChainedCommand,
  print: (line) => {
    console.log(line);
  },
  exit: (code) => {
    process.exit(code);
  },
};

export async function runStatusline(agent: string, io: StatuslineIO = PROCESS_IO): Promise<void> {
  const raw = await io.readStdin();

  const session = readSessionEnv(process.env);
  const sock = session.socket;
  const atcId = session.sessionID;

  if (sock !== undefined && atcId !== undefined) {
    let payload: Record<string, unknown> = {};

    try {
      const parsed: unknown = JSON.parse(raw);

      if (isRecord(parsed)) {
        payload = parsed;
      }
    } catch {}

    const line = `${JSON.stringify({ atcId, ...(agent === '' ? {} : { agent }), event: 'Statusline', payload })}\n`;

    await sendReport(sock, line, 500);
  }

  let chained = '';

  try {
    const cmd = loadClaudeStatusLine().command;

    if (cmd !== undefined && cmd !== '' && !isSelfCommand(cmd)) {
      const output = await io.runChained(cmd, raw);

      chained = output.trimEnd();
    }
  } catch {}

  const segment =
    session.bridge === true && sock !== undefined
      ? await readOwnSegment(sock)
      : readFleetSegment(io);

  io.print([chained, segment].filter((part) => part !== '').join(' \u001B[90m▏\u001B[0m '));

  // always 0, so the statusline never breaks the session it renders for
  io.exit(0);
}

// The user's statusline gets this long before atc renders without it.
const CHAINED_TIMEOUT_MS = 1500;

async function runChainedCommand(command: string, stdin: string): Promise<string> {
  const subprocess = Bun.spawn(['bash', '-c', command], {
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'ignore',
  });

  const timer = setTimeout(() => {
    subprocess.kill();
  }, CHAINED_TIMEOUT_MS);

  const text = await new Response(subprocess.stdout).text();

  clearTimeout(timer);

  return text;
}

// A user statusline that is atc's own injected command would chain into
// itself; the injected command ends with the bare subcommand, or with the
// subcommand and its agent flag, its value after a space or an `=`.
function isSelfCommand(cmd: string): boolean {
  return cmd.includes('statusline.ts') || /\sstatusline(?:\s+--agent[\s=].*)?$/u.test(cmd);
}

// Inside a remote host the status file is out of reach, and the session
// bridge returns the session's own state alone, never the rest of the fleet.
async function readOwnSegment(sock: string): Promise<string> {
  const status = await sendBridgeRequest(sock, 'status.read', {}, 500);

  if (status === null || status['ok'] !== true) {
    return '';
  }

  if (status['state'] === 'needs_you') {
    return '\u001B[1;31m● needs you\u001B[0m';
  }

  if (status['state'] === 'done') {
    return '\u001B[32m✓ done\u001B[0m';
  }

  return status['state'] === 'running' ? '\u001B[36m◐ running\u001B[0m' : '';
}

// The fleet segment, from the status file the daemon writes beside it.
function readFleetSegment(io: StatuslineIO): string {
  let segment = '';

  try {
    const status: unknown = JSON.parse(io.readStatusFile());

    if (isRecord(status)) {
      const needsYou = typeof status['needs_you'] === 'number' ? status['needs_you'] : 0;
      const done = typeof status['done'] === 'number' ? status['done'] : 0;
      const running = typeof status['running'] === 'number' ? status['running'] : 0;
      const urgent = typeof status['urgent'] === 'string' ? status['urgent'] : '';
      const parts: string[] = [];

      if (needsYou > 0) {
        const who = urgent === '' ? '' : `: ${urgent}`;

        parts.push(`\u001B[1;31m● ${needsYou} need you${who}\u001B[0m`);
      }

      if (done > 0) {
        parts.push(`\u001B[32m✓ ${done}\u001B[0m`);
      }

      if (running > 0) {
        parts.push(`\u001B[36m◐ ${running}\u001B[0m`);
      }

      segment = parts.join(' ');
    }
  } catch {}

  return segment;
}
