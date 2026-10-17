import { DaemonError } from '@atc/protocol/wire';
import type { MenuTerminal } from './menu-terminal';

export function sendMenuKey(terminal: MenuTerminal, key: string): void {
  // an exited session keeps its last screen, so a menu read can still match
  // after its agent is gone
  if (!terminal.isLive()) {
    throw new DaemonError('session_dead', 'the session has no live process, so nothing was picked');
  }

  terminal.write(key);
}
