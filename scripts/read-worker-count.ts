import { availableParallelism, totalmem } from 'node:os';
import { readMemoryBudget, readOptionalText } from './read-memory-budget.ts';
import type { MemoryBudgetSources } from './read-memory-budget.ts';

export interface WorkerCountSources extends MemoryBudgetSources {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cores: number;
}

export type WorkerCount =
  | { readonly kind: 'count'; readonly count: number }
  | { readonly kind: 'invalid'; readonly message: string };

const gibibyte = 1024 ** 3;

// Test memory grows in a straight line with the workers, and a host under this budget runs out with
// a second one.
const smallHostBudget = 4 * gibibyte;
const maxWorkers = 4;

export async function readWorkerCount(sources: Readonly<WorkerCountSources>): Promise<WorkerCount> {
  const override = sources.env['TEST_WORKERS'];

  if (override !== undefined) {
    const count = Number(override);

    return /^[1-9]\d*$/u.test(override) && Number.isSafeInteger(count)
      ? { kind: 'count', count }
      : {
          kind: 'invalid',
          message: `TEST_WORKERS is ${override}; set it to a whole number above 0`,
        };
  }

  const budget = await readMemoryBudget(sources);

  return {
    kind: 'count',
    count: budget < smallHostBudget ? 1 : Math.min(sources.cores, maxWorkers),
  };
}

if (import.meta.main) {
  const workers = await readWorkerCount({
    env: process.env,
    cores: availableParallelism(),
    totalMemory: totalmem(),
    procRoot: '/proc',
    cgroupRoot: '/sys/fs/cgroup',
    readText: readOptionalText,
  });

  if (workers.kind === 'invalid') {
    process.stderr.write(`read-worker-count: ${workers.message}\n`);
    process.exit(2);
  }

  process.stdout.write(`${workers.count}\n`);
}
