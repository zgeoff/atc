import { buildJumpPlan } from './build-jump-plan';
import { toFoldedGraphemes } from './to-folded-graphemes';

export interface JumpState {
  // the letters that matched the rows
  readonly typed: string;

  // the first letter of a two-letter label, waiting for its second
  readonly prefix: string;
}

export type JumpStep =
  | { readonly kind: 'continue'; readonly state: JumpState }
  | { readonly kind: 'picked'; readonly index: number };

// One typed character in jump mode, over every session's name in list order. A letter that is a
// label of a drawn row picks that row; any other letter joins the typed letters, and the one row
// that then matches is picked at once, drawn or not.
export function stepJump(
  state: JumpState,
  character: string,
  names: readonly string[],
  isShown: readonly boolean[],
): JumpStep {
  const letter = toFoldedGraphemes(character).join('');
  const labels = buildJumpPlan(names, state.typed, isShown).labels;
  const picked = labels.indexOf(`${state.prefix}${letter}`);

  if (picked !== -1) {
    return { kind: 'picked', index: picked };
  }

  if (state.prefix !== '') {
    return { kind: 'continue', state: { ...state, prefix: '' } };
  }

  if (labels.some((label) => label !== null && label.length === 2 && label.startsWith(letter))) {
    return { kind: 'continue', state: { ...state, prefix: letter } };
  }

  const typed = `${state.typed}${letter}`;
  const matches = buildJumpPlan(names, typed, isShown).matches;
  const only = matches.indexOf(true);

  if (only !== -1 && matches.lastIndexOf(true) === only) {
    return { kind: 'picked', index: only };
  }

  return { kind: 'continue', state: { typed, prefix: '' } };
}
