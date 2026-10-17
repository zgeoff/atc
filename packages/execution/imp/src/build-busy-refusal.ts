import { DaemonError } from '@atc/protocol/wire';

export function buildBusyRefusal(name: string): DaemonError {
  return new DaemonError(
    'host_unavailable',
    `imp ${name} stays awake: a session runs there or is starting there`,
    { provider: 'imp', problem: 'busy' },
  );
}
