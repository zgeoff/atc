import type { DockerTarget } from '../config/parse-docker-target';
import type { DockerEngine } from '../engine/types';
import { buildHostRefusal } from './build-host-refusal';

// the Engine's word for each architecture a daemon's binary runs on
const ENGINE_ARCHITECTURES: Readonly<Record<string, string>> = {
  x64: 'x86_64',
  arm64: 'aarch64',
};

export async function requireDockerEngine(
  engine: DockerEngine,
  target: DockerTarget,
  bootID: string | null,
): Promise<string> {
  const info = await engine.readInfo();

  if (
    info.osType !== 'linux' ||
    info.architecture !== ENGINE_ARCHITECTURES[process.arch] ||
    bootID === null
  ) {
    throw buildHostRefusal(
      'engine_unsupported',
      `the Docker Engine at ${target.socket} runs ${info.osType} on ${info.architecture}; the docker provider needs a native Linux Engine of the daemon's own architecture`,
      { osType: info.osType, architecture: info.architecture },
    );
  }

  return bootID;
}
