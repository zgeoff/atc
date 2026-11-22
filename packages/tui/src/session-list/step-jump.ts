import { buildJumpPlan } from './build-jump-plan';

export interface JumpState {
  // the letters that matched the rows
  readonly typed: string;

  // the first letter of a two-letter label, waiting for its second
  readonly prefix: string;
}

export type JumpStep =
  | { readonly kind: 'continue'; readonly state: JumpState }
  | { readonly kind: 'picked'; readonly index: number };

// One typed character in jump mode. The names are every session's, in list order, and a picked
// index counts into them. A letter that is a label picks its row; any other letter joins the typed
// letters, and the one row that then matches is picked at once.
export function stepJump(state: JumpState, character: string, names: readonly string[]): JumpStep {
  const letter = character.toLowerCase();
  const labels = buildJumpPlan(names, state.typed).labels;
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
  const matches = buildJumpPlan(names, typed).matches;
  const only = matches.indexOf(true);

  if (only !== -1 && matches.lastIndexOf(true) === only) {
    return { kind: 'picked', index: only };
  }

  return { kind: 'continue', state: { typed, prefix: '' } };
}
