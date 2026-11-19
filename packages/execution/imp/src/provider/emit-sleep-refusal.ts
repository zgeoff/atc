import type { ImpHost } from '../port/imp-host';

export function emitSleepRefusal(host: ImpHost): void {
  const listeners = [...host.sleepRefusals];

  host.sleepRefusals.clear();

  for (const listener of listeners) {
    listener();
  }
}
