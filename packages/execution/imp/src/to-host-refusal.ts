import { DaemonError } from '@atc/protocol/wire';
import { ImpPortError } from './imp-port-error';

export function toHostRefusal(error: unknown, name: string): DaemonError {
  if (error instanceof DaemonError) {
    return error;
  }

  const code = error instanceof ImpPortError ? error.code : 'UNKNOWN';
  const detail = error instanceof Error ? error.message : String(error);

  return new DaemonError('host_unavailable', `imp ${name} cannot be used: ${detail}`, {
    provider: 'imp',
    problem: code.toLowerCase(),
  });
}
