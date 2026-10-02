import { randomUUID } from 'node:crypto';

/**
 * A fresh OAuth client id for a client that registered itself: a random uuid
 * behind a `c-` prefix.
 */
export function mintClientID(): string {
  return `c-${randomUUID()}`;
}
