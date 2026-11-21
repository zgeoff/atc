import { loadClaudeStatusLine } from '@atc/config/claude-statusline';
import { isRecord } from '@atc/core';
import { readSessionEnv } from '@atc/protocol/session';
import { sendReport } from './send-report';

interface StatuslineIO {
  readonly readStdin: () => Promise<string>;

  readonly runChained: (command: string, stdin: string) => Promise<string>;
  readonly print: (line: string) => void;
  readonly exit: (code: number) => void;
}

const PROCESS_IO: StatuslineIO = {
  readStdin: () => new Response(Bun.stdin.stream()).text(),
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

  io.print(chained);
  io.exit(0);
}

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

function isSelfCommand(cmd: string): boolean {
  return cmd.includes('statusline.ts') || /\sstatusline(?:\s+--agent[\s=].*)?$/u.test(cmd);
}
