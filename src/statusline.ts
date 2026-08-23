import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { statusFile } from './shared/config';
import { isRecord, sendReport } from './shared/report';

/**
 * Runs as the statusLine command injected into wrangled sessions. Chains the
 * user's own statusline (from ~/.claude/settings.json), appends the atc fleet
 * segment, and heartbeats the session id back to the atc socket. Always
 * exits 0 so it never breaks the session it renders for.
 */
export async function runStatusline(): Promise<void> {
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

    const line = `${JSON.stringify({ atcId, event: 'Statusline', payload })}\n`;

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

  const line = [chained, segment].filter((part) => part !== '').join(' \u001B[90m▏\u001B[0m ');

  console.log(line);
  process.exit(0);
}

// A user statusline that is atc's own injected command would chain into
// itself; the injected command always ends with the bare subcommand.
function isSelfCommand(cmd: string): boolean {
  return cmd.includes('statusline.ts') || cmd.trimEnd().endsWith(' statusline');
}
