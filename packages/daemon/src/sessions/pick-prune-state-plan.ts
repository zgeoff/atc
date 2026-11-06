interface PruneStateInput {
  // Without remove, a dry run that only reports the folder.
  readonly remove: boolean;

  // Whether a session with the folder's id lists or spawns now.
  readonly owned: boolean;
}

// `report` is a dry run's `remove`.
export type PruneStatePlan = 'report' | 'keep' | 'remove';

export function pickPruneStatePlan(input: PruneStateInput): PruneStatePlan {
  if (!input.remove) {
    return 'report';
  }

  return input.owned ? 'keep' : 'remove';
}
