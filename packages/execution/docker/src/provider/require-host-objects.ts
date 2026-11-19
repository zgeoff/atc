import type { DockerTarget } from '../config/parse-docker-target';
import type { DockerEngine, Labels } from '../engine/types';
import { buildHostNames } from './build-host-names';
import { buildHostRefusal } from './build-host-refusal';

export async function requireHostObjects(
  engine: DockerEngine,
  target: DockerTarget,
  claim: Readonly<{ targetID: string; host: string; daemon: string | null }>,
): Promise<void> {
  const targetID = claim.targetID;
  const host = claim.host;
  const daemon = claim.daemon;
  const names = buildHostNames(target, host);

  const volumes = await Promise.all(
    [names.hostVolume, names.relayVolume].map((name) => engine.readVolume(name)),
  );

  const containers = await engine.listContainers({ 'atc.target': targetID, 'atc.host': host });

  for (const volume of volumes) {
    if (volume === null) {
      continue;
    }

    if (volume.labels['atc.target'] !== targetID || volume.labels['atc.host'] !== host) {
      throw buildHostRefusal(
        'host_exists',
        `volume ${volume.name} exists and is not a host of target ${targetID}`,
        { volume: volume.name },
      );
    }
  }

  const labelled: readonly Labels[] = [
    ...volumes.flatMap((volume) => (volume === null ? [] : [volume.labels])),
    ...containers.map((container) => container.labels),
  ];

  if (labelled.some((labels) => labels['atc.daemon'] !== daemon)) {
    throw buildHostRefusal(
      'host_leased',
      `host ${host} belongs to another daemon, and atc never takes it over`,
      { host },
    );
  }
}
