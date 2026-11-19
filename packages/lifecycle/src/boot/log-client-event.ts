import { appendFileSync } from 'node:fs';

// Log to a file: the client's stdout and stderr are the terminal it draws on.
export function logClientEvent(line: string): void {
  const path = process.env['ATC_CLIENT_LOG'];

  if (path === undefined || path === '') {
    return;
  }

  try {
    appendFileSync(path, `${line}\n`);
  } catch {}
}
