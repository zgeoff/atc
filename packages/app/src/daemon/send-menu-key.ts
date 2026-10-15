import { DaemonError } from '@atc/protocol/wire';
import type { MenuTerminal } from './menu-terminal';

/**
 * Writes one key to the session's PTY. A session that exits keeps its last
 * screen, so a menu read can still match after its agent is gone; the key
 * checks the PTY first and throws `session_dead` when it no longer runs.
 */
export function sendMenuKey(terminal: MenuTerminal, key: string): void {
  if (!terminal.isLive()) {
    throw new DaemonError('session_dead', 'the session has no live process, so nothing was picked');
  }

  terminal.write(key);
}
