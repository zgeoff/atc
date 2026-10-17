import { z } from 'zod';

// an option's number counts from 1 across the whole menu, even past the
// screen; the token changes with the text, a label or a box, not the cursor
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
