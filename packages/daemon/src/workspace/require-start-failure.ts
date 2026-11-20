import { AtcError } from '@atcx/contract/light';
import { toDaemonError } from './to-daemon-error';

export function requireStartFailure(error: unknown): null {
  if (error instanceof AtcError) {
    throw toDaemonError(error, 'internal', 'resolving');
  }

  return null;
}
