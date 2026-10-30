import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

interface TestHomeProcessesOptions {
  // The run directory of with-test-home.sh, which each process the run starts holds in
  // ATC_TEST_HOME.
  readonly root: string;

  readonly procRoot: string;

  // The caller holds the run's variables too, and keeps running.
  readonly ownPID: number;
}

export async function stopTestHomeProcesses(
  options: Readonly<TestHomeProcessesOptions>,
): Promise<number[]> {
  const pids = await readTestHomeProcesses(options);

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }

  return pids;
}

async function readTestHomeProcesses(
  options: Readonly<TestHomeProcessesOptions>,
): Promise<number[]> {
  const marker = `ATC_TEST_HOME=${options.root}`;

  // macOS has no procfs, so a run there stops nothing.
  const names = await readdir(options.procRoot).catch(() => []);

  const matches = await Promise.all(
    names
      .filter((name) => /^\d+$/u.test(name) && Number(name) !== options.ownPID)
      .map(async (name) => {
        // Bun.file reads 0 bytes from procfs. Another user's process refuses the read, and a
        // process that exits first takes its file with it.
        const environ = await readFile(join(options.procRoot, name, 'environ'), 'utf8').catch(
          () => '',
        );

        return environ.split('\0').includes(marker) ? Number(name) : null;
      }),
  );

  return matches.filter((pid) => pid !== null);
}

// parseArgs throws on an option it does not declare, which the caller reports as a refused input.
function parseCLIArgs(args: readonly string[]): string | Error {
  try {
    const parsed = parseArgs({ args: [...args], options: {}, allowPositionals: true });
    const positionals = parsed.positionals;
    const [root] = positionals;

    return positionals.length === 1 && root !== undefined && root !== ''
      ? root
      : new Error('pass the run directory as the only argument');
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

if (import.meta.main) {
  const root = parseCLIArgs(process.argv.slice(2));

  if (root instanceof Error) {
    process.stderr.write(`stop-test-home-processes: ${root.message}\n`);
    process.exit(2);
  }

  await stopTestHomeProcesses({ root, procRoot: '/proc', ownPID: process.pid });
}
