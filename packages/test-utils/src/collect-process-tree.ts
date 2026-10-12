import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface TreeProcess {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Collects the argv and environment of every live process descended from
 * the root process, read from `/proc`, so a test can check what a child
 * was started with while it still runs. The root itself is left out. A
 * process that exits during the scan is left out too. Linux only, since
 * only Linux has `/proc`.
 */
export async function collectProcessTree(rootPID: number): Promise<TreeProcess[]> {
  const entries = await readdir('/proc');

  const pids = entries.filter((entry) => /^\d+$/u.test(entry));

  const parents = new Map<string, string>();

  for (const pid of pids) {
    const stat = await readFile(join('/proc', pid, 'stat'), 'utf8').catch(() => '');

    // The fields after the parenthesised command name start with the state,
    // then the parent pid.
    parents.set(pid, stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1] ?? '');
  }

  const root = String(rootPID);
  const tree: TreeProcess[] = [];

  for (const pid of pids) {
    if (!isDescendant(parents, pid, root)) {
      continue;
    }

    const cmdline = await readFile(join('/proc', pid, 'cmdline'), 'utf8').catch(() => null);
    const environ = await readFile(join('/proc', pid, 'environ'), 'utf8').catch(() => null);

    if (cmdline === null || environ === null) {
      continue;
    }

    tree.push({
      pid: Number(pid),
      argv: splitNullTerminated(cmdline),
      env: Object.fromEntries(
        splitNullTerminated(environ).map((entry) => {
          const equals = entry.indexOf('=');

          return [entry.slice(0, equals), entry.slice(equals + 1)];
        }),
      ),
    });
  }

  return tree;
}

function isDescendant(parents: ReadonlyMap<string, string>, pid: string, root: string): boolean {
  let ancestor = parents.get(pid);

  while (ancestor !== undefined && ancestor !== root) {
    ancestor = parents.get(ancestor);
  }

  return ancestor === root;
}

function splitNullTerminated(text: string): string[] {
  return text.split('\0').filter((entry) => entry !== '');
}
