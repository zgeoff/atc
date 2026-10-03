import type { DaemonID } from './daemon-id';

/**
 * Trusts a string as a daemon id. This is the one point in the codebase
 * where a plain string becomes a `DaemonID`, and it adds no runtime check:
 * the caller asserts the string is the id a daemon minted for itself.
 */
export function toDaemonID(id: string): DaemonID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the one point where a string is trusted as a DaemonID
  return id as DaemonID;
}
