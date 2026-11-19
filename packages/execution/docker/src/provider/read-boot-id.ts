import { readFileSync } from 'node:fs';

// The id of the current boot of this Linux machine, or null on a machine that keeps none.
export function readBootID(): string | null {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch {
    return null;
  }
}
