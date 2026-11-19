import type { DockerTarget } from '../config/parse-docker-target';
import type { DockerEngine } from '../engine/types';
import { PROBE_SIGN_IN_SCRIPT } from '../guest-scripts/probe-sign-in-script';
import { buildHostRefusal } from './build-host-refusal';
import { runThrowawayContainer } from './run-throwaway-container';

export async function requireSignIn(engine: DockerEngine, target: DockerTarget): Promise<void> {
  const volume = await engine.readVolume(target.signInVolume);

  const missing = buildHostRefusal(
    'sign_in_missing',
    `volume ${target.signInVolume} holds no readable claude-oauth-token file; the docker guide shows how to store one`,
    { volume: target.signInVolume },
  );

  if (volume === null) {
    throw missing;
  }

  const probe = await runThrowawayContainer(engine, {
    namePrefix: target.namePrefix,
    image: target.image,
    labels: {},
    cmd: ['sh', '-c', PROBE_SIGN_IN_SCRIPT, 'sh', `${target.guestDir}/sign-in`],
    mounts: [
      {
        kind: 'volume',
        source: target.signInVolume,
        target: `${target.guestDir}/sign-in`,
        readOnly: true,
      },
    ],
  });

  if (probe.exitCode !== 0) {
    throw missing;
  }
}
