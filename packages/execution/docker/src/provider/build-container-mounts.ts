import type { DockerTarget } from '../config/parse-docker-target';
import type { Mount } from '../engine/types';
import type { HostNames } from './build-host-names';

export type ContainerRole = 'harness' | 'sidecar' | 'run';

export interface MountSources {
  readonly target: DockerTarget;
  readonly names: HostNames;

  readonly home: string;
  readonly atcBinary: string;
  readonly recordsDir: string;
}

export function buildContainerMounts(sources: MountSources, role: ContainerRole): Mount[] {
  const guestDir = sources.target.guestDir;

  const binary: Mount = {
    kind: 'bind',
    source: sources.atcBinary,
    target: `${guestDir}/bin/atc`,
    readOnly: true,
  };

  const relay: Mount = {
    kind: 'volume',
    source: sources.names.relayVolume,
    target: `${guestDir}/relay`,
    readOnly: false,
  };

  if (role === 'sidecar') {
    return [relay, binary];
  }

  const shared: Mount[] = [
    { kind: 'volume', source: sources.names.hostVolume, target: sources.home, readOnly: false },
    {
      kind: 'volume',
      source: sources.target.signInVolume,
      target: `${guestDir}/sign-in`,
      readOnly: true,
    },
    binary,
    { kind: 'bind', source: sources.recordsDir, target: `${guestDir}/records`, readOnly: true },
  ];

  return role === 'harness' ? [...shared, relay] : shared;
}
