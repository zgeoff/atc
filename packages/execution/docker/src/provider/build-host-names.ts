import type { DockerTarget } from '../config/parse-docker-target';

export interface HostNames {
  readonly hostVolume: string;
  readonly relayVolume: string;
}

export function buildHostNames(target: DockerTarget, host: string): HostNames {
  return {
    hostVolume: `${target.namePrefix}${host}`,
    relayVolume: `${target.namePrefix}${host}-relay`,
  };
}
