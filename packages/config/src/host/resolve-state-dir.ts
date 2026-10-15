import { join } from 'node:path';

/**
 * The state directory atc keeps under a home: the database, the status
 * file, the daemon's record, and the restart records live there.
 */
export function resolveStateDir(home: string): string {
  return join(home, '.local', 'state', 'atc');
}
