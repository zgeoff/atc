import { DaemonError } from '@atc/protocol/wire';

export type HostProblem = 'api_error' | 'host_exists' | 'busy';

export function buildHostRefusal(
  problem: HostProblem,
  message: string,
  data: Readonly<Record<string, unknown>> = {},
): DaemonError {
  return new DaemonError('host_unavailable', message, { provider: 'sprites', problem, ...data });
}
