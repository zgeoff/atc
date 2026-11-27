import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createStandInImage } from '@atc/execution-docker/test-utils/create-stand-in-image';
import { runDocker } from '@atc/execution-docker/test-utils/run-docker';
import { buildWarmupReport } from './build-warmup-report';

interface DockerWarmup {
  readonly atcBinary: string;
  readonly workDir: string;
  readonly write: (line: string) => void;
}

const WARM_IMAGE = 'atcwarm-image';

// The first docker e2e test builds the stand-in image from these same layers and starts its first
// containers inside its 15 s limit. Run on a disposable runner: the image stays, so the tests reuse it.
export async function runDockerWarmup(warmup: DockerWarmup): Promise<void> {
  // Docker creates a missing bind-mount source as an empty folder on the host.
  if (!isAbsolute(warmup.atcBinary) || !existsSync(warmup.atcBinary)) {
    throw new Error(`no atc binary at '${warmup.atcBinary}'`);
  }

  if (!isAbsolute(warmup.workDir)) {
    throw new Error(`the work folder '${warmup.workDir}' is not an absolute path`);
  }

  const withTiming = async (step: string, run: () => Promise<unknown>): Promise<void> => {
    const startedMs = performance.now();

    await run();

    warmup.write(buildWarmupReport(step, performance.now() - startedMs));
  };

  await withTiming('image build', () => createStandInImage(warmup.workDir, WARM_IMAGE));

  await withTiming('first container', () =>
    runDocker('run', '--rm', '--entrypoint', 'true', WARM_IMAGE),
  );

  await withTiming('atc binary in a container', () =>
    runDocker(
      'run',
      '--rm',
      '--entrypoint',
      '/warm/atc',
      '--volume',
      `${warmup.atcBinary}:/warm/atc:ro`,
      WARM_IMAGE,
      '--version',
    ),
  );
}

if (import.meta.main) {
  try {
    await runDockerWarmup({
      atcBinary: process.env['ATC_BIN'] ?? '',
      workDir: process.env['RUNNER_TEMP'] ?? '',
      write: (line) => {
        process.stdout.write(`${line}\n`);
      },
    });
  } catch (error) {
    process.stderr.write(
      `run-docker-warmup: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    process.exit(1);
  }
}
