import type { ScreenMenu } from '@atc/plugin-api';
import { expandScreenMenu } from './expand-screen-menu';
import type { MenuTerminal } from './menu-terminal';

/**
 * Reads the menu the session's screen shows without pressing a key, or null
 * when it shows none. When the screen shows part of the whole menu atc last
 * read through a scrolled list, it returns that whole menu with the
 * screen's boxes and cursor, and keeps it for the next read. Any other
 * screen reads as it stands, with its scroll marks, and drops the whole
 * menu, so a menu that closes and opens again is read afresh.
 */
export async function readKnownMenu(terminal: MenuTerminal): Promise<ScreenMenu | null> {
  const shown = await terminal.readScreenMenu();

  const known = terminal.findWholeMenu();
  const expanded = shown === null || known === null ? null : expandScreenMenu(shown, known);

  terminal.recordWholeMenu(expanded);

  return expanded ?? shown;
}
