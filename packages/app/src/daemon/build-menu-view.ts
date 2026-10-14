import { createHash } from 'node:crypto';
import type { ScreenMenu } from '@atc/plugin-api/agent-adapter';
import type { MenuView } from '@atc/protocol/menu-view';

/**
 * The menu as a client reads it: each option numbered from 1, and a token
 * built from the text, the labels and the boxes. A cursor move keeps the
 * token, so a choice that walks the cursor to its option still matches it.
 */
export function buildMenuView(menu: ScreenMenu): MenuView {
  const menuToken = createHash('sha256')
    .update(
      JSON.stringify([menu.text, menu.options.map((option) => [option.label, option.checked])]),
    )
    .digest('hex')
    .slice(0, 16);

  return {
    text: menu.text,
    options: menu.options.map((option, index) => ({
      option: index + 1,
      label: option.label,
      checked: option.checked,
      highlighted: index === menu.highlighted,
    })),
    menuToken,
  };
}
