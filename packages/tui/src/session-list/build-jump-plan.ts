import { findMatchedGraphemes } from './find-matched-graphemes';
import { pickJumpLabels } from './pick-jump-labels';

export interface JumpPlan {
  // for each name, whether it holds the typed letters; every name matches while nothing is typed
  readonly matches: readonly boolean[];

  // for each name, the label it shows, which only a matching name on screen has
  readonly labels: readonly (string | null)[];
}

// What jump mode shows for the typed letters: the names that match them, as one substring with
// case folded, and a label for each of those that `isShown` marks as on screen.
export function buildJumpPlan(
  names: readonly string[],
  typed: string,
  isShown: readonly boolean[],
): JumpPlan {
  const matches = names.map((name) => typed === '' || findMatchedGraphemes(name, typed) !== null);
  const matched = names.filter((_name, index) => matches[index] === true);
  const matchedShown = isShown.filter((_shown, index) => matches[index] === true);
  const matchedLabels = pickJumpLabels(matched, typed, matchedShown);
  let next = 0;

  const labels = matches.map((isMatch) => {
    if (!isMatch) {
      return null;
    }

    next += 1;

    return matchedLabels[next - 1] ?? null;
  });

  return { matches, labels };
}
