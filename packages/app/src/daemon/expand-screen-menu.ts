import type { ScreenMenu, ScreenMenuOption } from '@atc/plugin-api';
import { splitScreenMenu } from './split-screen-menu';

/**
 * The whole menu a screen shows part of, read through a whole menu atc
 * read before: the same text, the window's list rows in the whole list's
 * order, and the same items after the list. The window's boxes and cursor
 * replace the whole menu's, since the window is the newer read, and every
 * option out of view keeps its box as atc last saw it. Returns null when
 * the window is not part of that menu, or when its scroll marks show
 * options that the whole menu does not hold beside the window.
 */
export function expandScreenMenu(part: ScreenMenu, whole: ScreenMenu): ScreenMenu | null {
  if (part.text !== whole.text) {
    return null;
  }

  const shown = splitScreenMenu(part);
  const known = splitScreenMenu(whole);

  if (
    shown.list.length > known.list.length ||
    shown.after.length !== known.after.length ||
    shown.after.some((option, index) => option.label !== known.after[index]?.label)
  ) {
    return null;
  }

  const offset = findListOffset(part, shown.list, known.list);

  if (offset === null) {
    return null;
  }

  const list = known.list.map((option, index) => shown.list[index - offset] ?? option);

  const highlighted =
    part.highlighted < shown.list.length
      ? offset + part.highlighted
      : known.list.length + part.highlighted - shown.list.length;

  return { text: whole.text, options: [...list, ...shown.after], highlighted };
}

// Where the window's rows start in the whole list: the first place their
// labels match in order, with options above it only when the window marks
// some above, and options below it only when the window marks some below.
// A window without marks may sit anywhere, as one whose cursor hides its
// mark does.
function findListOffset(
  part: ScreenMenu,
  shown: readonly ScreenMenuOption[],
  known: readonly ScreenMenuOption[],
): number | null {
  for (let offset = 0; offset + shown.length <= known.length; offset++) {
    const matches = shown.every((option, index) => option.label === known[offset + index]?.label);
    const above = offset > 0;
    const below = offset + shown.length < known.length;

    if (
      matches &&
      (part.scroll?.above !== true || above) &&
      (part.scroll?.below !== true || below)
    ) {
      return offset;
    }
  }

  return null;
}
