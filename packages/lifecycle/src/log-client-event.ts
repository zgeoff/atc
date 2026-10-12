import { appendFileSync } from 'node:fs';

/**
 * Appends one line, a decision the client took without drawing anything, to
 * the file `ATC_CLIENT_LOG` holds, and does nothing when the variable is
 * unset or empty. A write that fails is dropped, so the log never stops the
 * client. It writes off the screen because the client's stdout and stderr
 * are the terminal it draws on.
 */
export function logClientEvent(line: string): void {
  const path = process.env['ATC_CLIENT_LOG'];

  if (path === undefined || path === '') {
    return;
  }

  try {
    appendFileSync(path, `${line}\n`);
  } catch {}
}
