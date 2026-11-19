interface PruneStateInput {
  readonly remove: boolean;

  readonly owned: boolean;
}

export type PruneStatePlan = 'report' | 'keep' | 'remove';

export function pickPruneStatePlan(input: PruneStateInput): PruneStatePlan {
  if (!input.remove) {
    return 'report';
  }

  return input.owned ? 'keep' : 'remove';
}
