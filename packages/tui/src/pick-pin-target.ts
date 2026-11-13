import type { DaemonName } from './session-key';

interface PinCandidate {
  readonly daemon: DaemonName;
  readonly id: string;
  readonly parent: string | null;
  readonly pinned: boolean;
}

// A sub-session's parent lives on the same daemon, so another daemon's row with the parent's id
// is never the target.
export function pickPinTarget<T extends PinCandidate>(selected: T, list: readonly T[]): T {
  if (selected.parent === null || selected.pinned) {
    return selected;
  }

  return list.find((x) => x.id === selected.parent && x.daemon === selected.daemon) ?? selected;
}
