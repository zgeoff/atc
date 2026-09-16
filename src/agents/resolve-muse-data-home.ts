import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Muse Code's data directory, which holds the session index and the session
 * logs. Muse resolves it through XDG_DATA_HOME, so atc must too — a session
 * started under a non-default XDG_DATA_HOME writes its index somewhere the
 * default path would never find.
 */
export function resolveMuseDataHome(): string {
  const xdg = process.env['XDG_DATA_HOME'];

  return xdg !== undefined && xdg !== ''
    ? join(xdg, 'muse')
    : join(homedir(), '.local', 'share', 'muse');
}
