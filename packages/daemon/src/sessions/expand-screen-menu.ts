import type { ScreenMenu, ScreenMenuOption } from '@atc/plugin-api';
import { splitScreenMenu } from './split-screen-menu';

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

  // the window is the newer read, so its boxes win; options out of view keep the boxes last seen
  const list = known.list.map((option, index) => shown.list[index - offset] ?? option);

  const highlighted =
    part.highlighted < shown.list.length
      ? offset + part.highlighted
      : known.list.length + part.highlighted - shown.list.length;

  return { text: whole.text, options: [...list, ...shown.after], highlighted };
}

// a window matching in more than one place, as repeated labels allow, has no place, since the
// screen cannot show which one the cursor is in
function findListOffset(
  part: ScreenMenu,
  shown: readonly ScreenMenuOption[],
  known: readonly ScreenMenuOption[],
): number | null {
  const found: number[] = [];

  for (let offset = 0; offset + shown.length <= known.length; offset++) {
    const matches = shown.every((option, index) => option.label === known[offset + index]?.label);
    const above = offset > 0;
    const below = offset + shown.length < known.length;

    if (
      matches &&
      isEdgeConsistent(part.scroll?.above === true, above, part.highlighted === 0) &&
      isEdgeConsistent(part.scroll?.below === true, below, part.highlighted === shown.length - 1)
    ) {
      found.push(offset);
    }
  }

  return found.length === 1 ? (found[0] ?? null) : null;
}

// Whether one edge of a window agrees with the whole list beyond it: a mark
// needs options there, and options there need a mark unless the cursor sits
// on that edge's row.
function isEdgeConsistent(marked: boolean, beyond: boolean, isCursorOnEdge: boolean): boolean {
  return marked ? beyond : !beyond || isCursorOnEdge;
}
