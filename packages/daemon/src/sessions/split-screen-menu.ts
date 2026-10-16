import type { ScreenMenu, ScreenMenuOption } from '@atc/plugin-api';

/**
 * A menu's options split into its list, which scrolls, and the items after
 * the list, which stay on the screen as it scrolls. In a menu with boxes
 * the items without a box after the last box follow the list; any other
 * menu is all list.
 */
export function splitScreenMenu(menu: ScreenMenu): {
  readonly list: readonly ScreenMenuOption[];
  readonly after: readonly ScreenMenuOption[];
} {
  const last = menu.options.findLastIndex((option) => option.checked !== null);

  if (last === -1) {
    return { list: menu.options, after: [] };
  }

  return { list: menu.options.slice(0, last + 1), after: menu.options.slice(last + 1) };
}
