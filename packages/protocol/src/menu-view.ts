import { z } from 'zod';

/**
 * A menu on a session's screen, as `session.menu` and `session.choose`
 * answer it: the text above its options, each option with its number
 * counted from 1, its label, whether its box is ticked (null for an option
 * with no box) and whether the cursor is on it, and the token a choice on
 * this menu carries. The token changes when the text, a label, or a box
 * changes, and stays when only the cursor moves.
 */
export const MENU_VIEW_SCHEMA = z.object({
  text: z.string(),
  options: z.array(buildMenuOptionSchema()).readonly(),
  menuToken: z.string(),
});

export type MenuView = z.output<typeof MENU_VIEW_SCHEMA>;

function buildMenuOptionSchema() {
  return z.object({
    option: z.number(),
    label: z.string(),
    checked: z.boolean().nullable(),
    highlighted: z.boolean(),
  });
}
