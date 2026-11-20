import { AtcError } from '@atcx/contract/light';

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

export function buildHostRefusal(
  problem: HostProblem,
  message: string,
  data: Readonly<Record<string, unknown>> = {},
): AtcError {
  return new AtcError('host_unavailable', message, { provider: 'docker', problem, ...data });
}
