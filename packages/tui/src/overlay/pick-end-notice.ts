import { AtcError } from '@atcx/contract/light';

// The notice for a refusal of an end that the user can act on, or null for any other failure.
export function pickEndNotice(error: unknown, name: string): string | null {
  if (!(error instanceof AtcError)) {
    return null;
  }

  if (error.code === 'session_pinned') {
    return `unpin ${name} first`;
  }

  if (error.code === 'unsupported_operation' && error.data['problem'] === 'host_asleep') {
    return `${name}'s machine is asleep: attach to wake it, then end it`;
  }

  return null;
}
