import { createHash } from 'node:crypto';
import type { ScreenMenu } from '@atc/plugin-api';
import type { MenuView } from '@atcx/contract';

export function buildMenuView(menu: ScreenMenu): MenuView {
  // the highlight stays out of the token, so a choice that walks the cursor still matches it
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
