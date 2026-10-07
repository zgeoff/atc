import { existsSync } from 'node:fs';
import type { AgentAdapter } from '../agents/agent-adapter';
import { buildMockAgentAdapter } from './build-mock-agent-adapter';

interface Plan {
  readonly bin: string;
  readonly args: readonly string[];
}

interface FailingAgentAdapterConfig {
  // What the first spawn runs, and what every later spawn runs.
  readonly firstPlan: Plan;
  readonly laterPlan: Plan;

  // How many reads of the headless runner throw once the first spawn is
  // planned: one fails the start after its process started, and a second
  // fails the kill that takes the process back.
  readonly failedReads: number;

  // A file the first spawn's process writes once it is ready to be killed;
  // the first failing read waits until it exists. Null fails at once.
  readonly readyFile: string | null;
}

/**
 * An agent adapter whose first spawn fails after its process has started:
 * the daemon reads the adapter's headless runner once the process runs, and
 * that read throws, as many times as the config holds, while every other
 * read finds no headless runner. Every member but the spawn plan and the
 * headless runner is the mock adapter's. `countPlans` reads how many spawns
 * the adapter has planned.
 */
export function buildStubFailingAgentAdapter(config: FailingAgentAdapterConfig) {
  let planned = 0;
  let readsToFail = 0;

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

      if (readsToFail === config.failedReads && config.readyFile !== null) {
        waitForFile(config.readyFile);
      }

      readsToFail -= 1;
      throw new Error('adapter failed after the process started');
    },
  };

  return { adapter, countPlans: () => planned };
}

// How long the first failing read waits for the ready file before it gives
// up, so a process that never gets ready fails the test instead of hanging.
const READY_TIMEOUT_MS = 5000;

// The headless runner is read synchronously, so the wait blocks.
function waitForFile(path: string): void {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`no process wrote ${path} within ${READY_TIMEOUT_MS}ms`);
    }

    Bun.sleepSync(10);
  }
}
