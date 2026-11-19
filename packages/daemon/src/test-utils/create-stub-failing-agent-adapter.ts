import { closeSync, constants, openSync, readSync } from 'node:fs';
import { runCommand } from '@atc/core/test-utils/run-command';
import type { AgentAdapter } from '@atc/plugin-api';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';

interface Plan {
  readonly bin: string;
  readonly args: readonly string[];
}

interface ReadyPipe {
  readonly path: string;
  readonly timeoutMs: number;
}

interface FailingAgentAdapterConfig {
  readonly firstPlan: Plan;
  readonly laterPlan: Plan;

  readonly failedReads: number;

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

// The caller is a synchronous getter, so the read polls with sleeps instead of blocking.
// A nonblocking read of a FIFO returns end-of-file before any writer has opened it, so the pid
// is complete only after bytes arrived and a later read returns end-of-file.
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
