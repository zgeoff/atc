import { pickJumpLabels } from './pick-jump-labels';

export interface JumpState {
  // the letters that narrowed the rows
  readonly typed: string;

  // the first letter of a two-letter label, waiting for its second
  readonly prefix: string;
}

export type JumpStep =
  | { readonly kind: 'continue'; readonly state: JumpState }
  | { readonly kind: 'picked'; readonly index: number };

// One typed character in jump mode. The names are the rows that match `state.typed`, and a picked
// index counts into them.
export function stepJump(state: JumpState, character: string, names: readonly string[]): JumpStep {
  const letter = character.toLowerCase();
  const labels = pickJumpLabels(names, state.typed);
  const candidate = `${state.prefix}${letter}`;
  const picked = labels.indexOf(candidate);

  if (picked !== -1) {
    return { kind: 'picked', index: picked };
  }

  if (state.prefix !== '') {
    return { kind: 'continue', state: { ...state, prefix: '' } };
  }

  if (labels.some((label) => label !== null && label.length === 2 && label.startsWith(letter))) {
    return { kind: 'continue', state: { ...state, prefix: letter } };
  }

  return { kind: 'continue', state: { typed: `${state.typed}${letter}`, prefix: '' } };
}
