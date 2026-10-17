import { DaemonError } from '@atc/protocol/wire';
import { toDaemonError } from './to-daemon-error';

// A git that cannot start, such as one given a cwd that is gone, reads as
// no answer; any refusal, such as git's output that stays open after it
// exits, is thrown on with the resolving phase so it fails the spawn.
export function requireStartFailure(error: unknown): null {
  if (error instanceof DaemonError) {
    throw toDaemonError(error, 'internal', 'resolving');
  }

  return null;
}
