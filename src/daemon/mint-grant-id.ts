import { randomUUID } from 'node:crypto';

/**
 * A fresh grant id: a random uuid behind a `g-` prefix. `atc grants` shows it,
 * and revoking a grant takes it.
 */
export function mintGrantID(): string {
  return `g-${randomUUID()}`;
}
