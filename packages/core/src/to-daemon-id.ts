import { toTagged } from '@zgeoff/std';
import type { DaemonID } from './daemon-id';

export function toDaemonID(id: string): DaemonID {
  return toTagged<DaemonID>(id);
}
