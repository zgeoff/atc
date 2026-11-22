import { pickJumpLabels } from './pick-jump-labels';

export interface JumpPlan {
  // for each name, whether it holds the typed letters; every name matches while nothing is typed
  readonly matches: readonly boolean[];

  // for each name, the label it shows, which only a matching name has
  readonly labels: readonly (string | null)[];
}

// What jump mode shows for the typed letters: the names that match them, as one substring with
// case ignored, and a label for each of those.
export function buildJumpPlan(names: readonly string[], typed: string): JumpPlan {
  const needle = typed.toLowerCase();
  const matches = names.map((name) => name.toLowerCase().includes(needle));
  const matched = names.filter((_name, index) => matches[index] === true);
  const matchedLabels = pickJumpLabels(matched, typed);
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
