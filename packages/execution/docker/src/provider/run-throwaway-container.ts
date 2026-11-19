import { randomUUID } from 'node:crypto';
import type { DockerEngine, Labels, Mount } from '../engine/types';
import { waitOut } from './wait-out';

export interface ThrowawayRun {
  readonly namePrefix: string;
  readonly image: string;
  readonly labels: Labels;
  readonly cmd: readonly string[];
  readonly workingDir?: string;
  readonly mounts: readonly Mount[];
  readonly stdin?: Uint8Array;
}

export interface ThrowawayResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export async function runThrowawayContainer(
  engine: DockerEngine,
  run: ThrowawayRun,
): Promise<ThrowawayResult> {
  const name = `${run.namePrefix}run-${randomUUID()}`;
  const hasStdin = run.stdin !== undefined;

  try {
    await engine.createContainer({
      name,
      image: run.image,
      labels: run.labels,
      cmd: run.cmd,
      env: {},
      ...(run.workingDir === undefined ? {} : { workingDir: run.workingDir }),
      tty: false,
      stdin: hasStdin ? 'once' : 'none',
      mounts: run.mounts,
    });

    const attachment = await engine.attachContainer(name, { stdin: hasStdin, logs: false });

    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const ended = Promise.withResolvers<void>();

    attachment.onData((data, stream) => {
      (stream === 'stdout' ? stdout : stderr).push(data);
    });

    attachment.onEnd(ended.resolve);

    await engine.startContainer(name);

    if (run.stdin !== undefined) {
      await attachment.write(run.stdin);

      attachment.closeWrite();
    }

    await ended.promise;

    return {
      exitCode: await readExitCode(engine, name),
      stdout: join(stdout),
      stderr: join(stderr),
    };
  } finally {
    await waitOut(engine.removeContainer(name));
  }
}

const EXIT_POLL_MS = 20;
const EXIT_POLLS = 100;

async function readExitCode(engine: DockerEngine, name: string): Promise<number> {
  for (let poll = 0; poll < EXIT_POLLS; poll += 1) {
    const container = await engine.readContainer(name);

    if (container === null) {
      throw new Error(`the Engine lost container ${name} before it reported an exit`);
    }

    if (container.status === 'exited' || container.status === 'dead') {
      return container.exitCode;
    }

    await Bun.sleep(EXIT_POLL_MS);
  }

  throw new Error(`container ${name} did not report an exit`);
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  return Buffer.concat(chunks);
}
