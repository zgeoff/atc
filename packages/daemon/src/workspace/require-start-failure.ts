import { DaemonError } from '@atc/protocol/wire';
import { toDaemonError } from './to-daemon-error';

export function requireStartFailure(error: unknown): null {
  if (error instanceof DaemonError) {
    throw toDaemonError(error, 'internal', 'resolving');
  }

  return null;
}
