import { AtcError } from '@atcx/contract/light';

export function buildBusyRefusal(name: string): AtcError {
  return new AtcError(
    'host_unavailable',
    `imp ${name} stays awake: a session runs there or is starting there`,
    { provider: 'imp', problem: 'busy' },
  );
}
