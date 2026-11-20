import { AtcError } from '@atcx/contract/light';

export type HostProblem = 'api_error' | 'host_exists' | 'busy';

export function buildHostRefusal(
  problem: HostProblem,
  message: string,
  data: Readonly<Record<string, unknown>> = {},
): AtcError {
  return new AtcError('host_unavailable', message, { provider: 'sprites', problem, ...data });
}
