interface PinCandidate {
  readonly id: string;
  readonly parent: string | null;
  readonly pinned: boolean;
}

export function pickPinTarget<T extends PinCandidate>(selected: T, list: readonly T[]): T {
  if (selected.parent === null || selected.pinned) {
    return selected;
  }

  return list.find((x) => x.id === selected.parent) ?? selected;
}
