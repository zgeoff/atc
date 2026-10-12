import type { AgentAdapter } from '../agents/agent-adapter';
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

/**
 * An agent adapter whose first spawn fails after its process has started:
 * the daemon reads the adapter's headless runner once the process runs, and
 * that read throws, as many times as the config holds, while every other
 * read finds no headless runner. Every member but the spawn plan and the
 * headless runner is the mock adapter's.
 *
 * With a ready pipe, the stub makes the pipe at that path before it
 * resolves, and the first failing read blocks until a process writes its
 * pid there, which the headless runner read is synchronous for. A read that finds no writer
 * within the timeout throws instead of failing the start. `getReadyPID`
 * returns the pid that read took. `countPlans` reads how many spawns the
 * adapter has planned.
 */
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

// Reading the pipe blocks until a writer opens it and closes it, so the
// read returns once the process has written its pid.
function readPID(ready: ReadyPipe): number {
  // oxlint-disable-next-line no-restricted-properties -- the adapter reads the pid inside a synchronous getter, so only a blocking read fits
  const read = Bun.spawnSync({ cmd: ['cat', ready.path], timeout: ready.timeoutMs });

  if (read.exitedDueToTimeout === true) {
    throw new Error(`no process wrote ${ready.path} within ${String(ready.timeoutMs)}ms`);
  }

  return Number(read.stdout.toString().trim());
}
