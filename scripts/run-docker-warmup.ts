import { createStandInImage } from '@atc/execution-docker/test-utils/create-stand-in-image';
import { runDocker } from '@atc/execution-docker/test-utils/run-docker';
import { buildWarmupReport } from './build-warmup-report';
import type { WarmupTiming } from './build-warmup-report';

interface DockerWarmup {
  readonly atcBinary: string;
  readonly workDir: string;
}

const WARM_IMAGE = 'atcwarm-image';

// Each docker e2e test builds the stand-in image from these same layers. On a fresh runner the
// first build and the first containers on it took longer than the 15 s a test gets.
export async function runDockerWarmup(warmup: DockerWarmup): Promise<string> {
  const timings: WarmupTiming[] = [];

  const timeStep = async (step: string, run: () => Promise<unknown>): Promise<void> => {
    const startedMs = performance.now();

    await run();

    timings.push({ step, durationMs: performance.now() - startedMs });
  };

  await timeStep('image build', () => createStandInImage(warmup.workDir, WARM_IMAGE));

  await timeStep('first container', () =>
    runDocker('run', '--rm', '--entrypoint', 'true', WARM_IMAGE),
  );

  await timeStep('atc binary in a container', () =>
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

  return buildWarmupReport(timings);
}

if (import.meta.main) {
  try {
    const report = await runDockerWarmup({
      atcBinary: process.env['ATC_BIN'] ?? '',
      workDir: process.env['RUNNER_TEMP'] ?? '',
    });

    process.stdout.write(`${report}\n`);
  } catch (error) {
    process.stderr.write(
      `run-docker-warmup: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    process.exit(1);
  }
}
