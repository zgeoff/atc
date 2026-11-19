import { DaemonError } from '@atc/protocol/wire';
import { toDaemonError } from './to-daemon-error';

// A git that cannot start, such as one run in a deleted cwd, counts as no answer.
// Any other failure, such as git output that stays open after it exits, must fail the spawn.
export function requireStartFailure(error: unknown): null {
  if (error instanceof DaemonError) {
    throw toDaemonError(error, 'internal', 'resolving');
  }

  return null;
}
