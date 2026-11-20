import { AtcError } from '@atcx/contract/light';
import { ImpPortError } from '../port/imp-port-error';

export function toHostRefusal(error: unknown, name: string): AtcError {
  if (error instanceof AtcError) {
    return error;
  }

  const code = error instanceof ImpPortError ? error.code : 'UNKNOWN';
  const detail = error instanceof Error ? error.message : String(error);

  return new AtcError('host_unavailable', `imp ${name} cannot be used: ${detail}`, {
    provider: 'imp',
    problem: code.toLowerCase(),
  });
}
