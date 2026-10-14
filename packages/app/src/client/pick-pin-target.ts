interface PinCandidate {
  readonly id: string;
  readonly parent: string | null;
  readonly pinned: boolean;
}

/**
 * The session the pin key acts on: a sub-session pins with its parent, so
 * the key acts on the parent, unless the sub-session carries a pin of its
 * own, which the key then unpins. A top-level session, or a sub-session
 * whose parent is not listed, is its own target.
 */
export function pickPinTarget<T extends PinCandidate>(selected: T, list: readonly T[]): T {
  if (selected.parent === null || selected.pinned) {
    return selected;
  }

  return list.find((x) => x.id === selected.parent) ?? selected;
}
