import { DaemonError } from '@atc/protocol/wire';

export type HostProblem =
  | 'image_missing'
  | 'engine_unreachable'
  | 'engine_unsupported'
  | 'sign_in_missing'
  | 'host_leased'
  | 'host_exists'
  | 'image_user_unusable'
  | 'busy'
  | 'engine_error';

// A refusal of the host: `host_unavailable`, with the problem and the facts a caller needs.
export function buildHostRefusal(
  problem: HostProblem,
  message: string,
  data: Readonly<Record<string, unknown>> = {},
): DaemonError {
  return new DaemonError('host_unavailable', message, { provider: 'docker', problem, ...data });
}
