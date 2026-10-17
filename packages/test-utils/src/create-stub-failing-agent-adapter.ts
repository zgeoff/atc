import { closeSync, constants, openSync, readSync } from 'node:fs';
import type { AgentAdapter } from '@atc/plugin-api';
import { buildMockAgentAdapter } from './build-mock-agent-adapter';
import { runCommand } from './run-command';

interface Plan {
  readonly bin: string;
  readonly args: readonly string[];
}

// A named pipe the first spawn's process writes its pid to once it is ready
// to be killed, and how long the first failing read waits for that pid.
interface ReadyPipe {
  readonly path: string;
  readonly timeoutMs: number;
}

interface FailingAgentAdapterConfig {
  // What the first spawn runs, and what every later spawn runs.
  readonly firstPlan: Plan;
  readonly laterPlan: Plan;

  // How many reads of the headless runner throw once the first spawn is
  // planned: one fails the start after its process started, and a second
  // fails the kill that takes the process back.
  readonly failedReads: number;

  // The pipe the first failing read waits on. Null fails at once.
  readonly ready: ReadyPipe | null;
}

export async function createStubFailingAgentAdapter(config: FailingAgentAdapterConfig) {
  let planned = 0;
  let readsToFail = 0;
  let readyPID: number | null = null;

  if (config.ready !== null) {
    await createPipe(config.ready.path);
  }

  const adapter: AgentAdapter = {
    ...buildMockAgentAdapter(),
    planSpawn: () => {
      planned += 1;

      if (planned > 1) {
        return { bin: config.laterPlan.bin, args: [...config.laterPlan.args] };
      }

      readsToFail = config.failedReads;

      return { bin: config.firstPlan.bin, args: [...config.firstPlan.args] };
    },
    get headlessRunner() {
      if (readsToFail === 0) {
        return null;
      }

      if (readsToFail === config.failedReads && config.ready !== null) {
        readyPID = readPID(config.ready);
      }

      readsToFail -= 1;
      throw new Error('adapter failed after the process started');
    },
  };

  return {
    adapter,
    countPlans: () => planned,
    getReadyPID: (): number => {
      if (readyPID === null) {
        throw new Error('no process has written its pid to the ready pipe');
      }

      return readyPID;
    },
  };
}

async function createPipe(path: string): Promise<void> {
  const made = await runCommand(['mkfifo', path]);

  if (made.exitCode !== 0) {
    throw new Error(`mkfifo could not make ${path} (${made.stderr.trim()})`);
  }
}

const PIPE_POLL_MS = 5;

// The adapter reads the pid inside a synchronous getter, so the read polls
// without blocking. A read finds the pipe at its end before a writer opens it
// too, so the pid is whole only once bytes came and a later read finds the end.
function readPID(ready: ReadyPipe): number {
  const fd = openSync(ready.path, constants.O_RDONLY | constants.O_NONBLOCK);
  const deadline = performance.now() + ready.timeoutMs;
  const chunk = Buffer.alloc(64);
  let text = '';

  try {
    while (performance.now() < deadline) {
      const size = tryReadPipe(fd, chunk);

      if (size === 0 && text !== '') {
        return Number(text.trim());
      }

      if (size !== null && size > 0) {
        text += chunk.toString('utf8', 0, size);
        continue;
      }

      Bun.sleepSync(PIPE_POLL_MS);
    }
  } finally {
    closeSync(fd);
  }

  throw new Error(`no process wrote ${ready.path} within ${String(ready.timeoutMs)}ms`);
}

// Null when a writer holds the pipe open with nothing written yet.
function tryReadPipe(fd: number, chunk: Buffer): number | null {
  try {
    return readSync(fd, chunk);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'EAGAIN') {
      return null;
    }

    throw error;
  }
}
