import type { ScreenMenu } from '@atc/plugin-api';
import { expandScreenMenu } from './expand-screen-menu';
import type { MenuTerminal } from './menu-terminal';

export async function readKnownMenu(terminal: MenuTerminal): Promise<ScreenMenu | null> {
  const shown = await terminal.readScreenMenu();

  const known = terminal.findWholeMenu();
  const expanded = shown === null || known === null ? null : expandScreenMenu(shown, known);

  // any other screen drops the kept whole menu, so a menu that closes and reopens is read afresh
  terminal.recordWholeMenu(expanded);

  return expanded ?? shown;
}
