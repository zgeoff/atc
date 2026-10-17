import type { DaemonID } from './daemon-id';

export function toDaemonID(id: string): DaemonID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the one point where a string is trusted as a DaemonID
  return id as DaemonID;
}
