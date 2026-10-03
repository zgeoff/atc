import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sendBridgeRequest } from './protocol/send-bridge-request';
import { statusFile } from './shared/config';
import { isRecord, sendReport } from './shared/report';

/**
 * Runs as the statusLine command injected into wrangled sessions. Chains the
 * user's own statusline (from ~/.claude/settings.json), appends the atc fleet
 * segment, and heartbeats the session id back to the atc socket, with the
 * agent id the command gave it. Always exits 0 so it never breaks the
 * session it renders for.
 */
export async function runStatusline(agent: string): Promise<void> {
  const raw = await new Response(Bun.stdin.stream()).text();

  const sock = process.env['ATC_SOCKET'];
  const atcId = process.env['ATC_SESSION_ID'];

  if (sock !== undefined && sock !== '' && atcId !== undefined && atcId !== '') {
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
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const rawSettings = readFileSync(settingsPath, 'utf8');
    const settings: unknown = JSON.parse(rawSettings);
    const statusLine = isRecord(settings) ? settings['statusLine'] : undefined;
    const cmd = isRecord(statusLine) ? statusLine['command'] : undefined;

    if (typeof cmd === 'string' && cmd !== '' && !isSelfCommand(cmd)) {
      const proc = Bun.spawn(['bash', '-c', cmd], {
        stdin: new TextEncoder().encode(raw),
        stdout: 'pipe',
        stderr: 'ignore',
      });

      const timer = setTimeout(() => {
        proc.kill();
      }, 1500);

      const text = await new Response(proc.stdout).text();

      chained = text.trimEnd();

      clearTimeout(timer);
    }
  } catch {}

  const segment =
    process.env['ATC_BRIDGE'] === '1' && sock !== undefined && sock !== ''
      ? await readOwnSegment(sock)
      : readFleetSegment();

  const line = [chained, segment].filter((part) => part !== '').join(' \u001B[90m▏\u001B[0m ');

  console.log(line);
  process.exit(0);
}

// The fleet segment, from the status file the daemon writes beside it.
function readFleetSegment(): string {
  let segment = '';

  try {
    const status: unknown = JSON.parse(readFileSync(statusFile, 'utf8'));

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

// A user statusline that is atc's own injected command would chain into
// itself; the injected command ends with the bare subcommand, or with the
// subcommand and its agent flag.
function isSelfCommand(cmd: string): boolean {
  return cmd.includes('statusline.ts') || /\sstatusline(?:\s+--agent\s.*)?$/u.test(cmd);
}
