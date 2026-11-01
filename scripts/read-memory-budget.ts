import { totalmem } from 'node:os';
import { join } from 'node:path';
import { readOptionalText } from './read-optional-text.ts';

export interface MemoryBudgetSources {
  readonly totalMemory: number;
  readonly procRoot: string;
  readonly cgroupRoot: string;
  readonly readText: (path: string) => Promise<string | undefined>;
}

export async function readMemoryBudget(sources: Readonly<MemoryBudgetSources>): Promise<number> {
  const caps = await readCgroupCaps(sources);

  return Math.min(sources.totalMemory, ...caps);
}

async function readCgroupCaps(sources: Readonly<MemoryBudgetSources>): Promise<number[]> {
  const membership = await sources.readText(join(sources.procRoot, 'self', 'cgroup'));

  // macOS has no procfs.
  if (membership === undefined) {
    return [];
  }

  const own = /^0::(?<path>\/.*)$/mu.exec(membership)?.groups?.['path'];

  // A host on cgroup v1 alone has no 0:: line.
  if (own === undefined) {
    return [];
  }

  const caps = await Promise.all(
    collectAncestorPaths(own).map((path) =>
      readCgroupCap(sources, join(sources.cgroupRoot, path, 'memory.max')),
    ),
  );

  return caps.filter((cap) => cap !== undefined);
}

function collectAncestorPaths(path: string): string[] {
  const parts = path.split('/').filter((part) => part !== '');

  return ['/', ...parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)];
}

// The root cgroup has no memory.max, and a cgroup with no cap holds max.
async function readCgroupCap(
  sources: Readonly<MemoryBudgetSources>,
  path: string,
): Promise<number | undefined> {
  const text = await sources.readText(path);

  const value = text?.trim();

  return value === undefined || value === 'max' ? undefined : Number(value);
}

// Bun.file's text reads as many bytes as stat reports, and procfs and cgroupfs report 0 for every
// file; readFile reads to the end.
if (import.meta.main) {
  const budget = await readMemoryBudget({
    totalMemory: totalmem(),
    procRoot: '/proc',
    cgroupRoot: '/sys/fs/cgroup',
    readText: readOptionalText,
  });

  process.stdout.write(`${Math.floor(budget / 1024 / 1024)}\n`);
}
