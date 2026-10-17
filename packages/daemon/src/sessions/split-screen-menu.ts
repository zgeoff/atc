import type { ScreenMenu, ScreenMenuOption } from '@atc/plugin-api';

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
