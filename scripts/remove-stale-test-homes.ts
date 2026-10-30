import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { stopTestHomeProcesses } from './stop-test-home-processes';

interface StaleTestHomesOptions {
  // The folder that holds the run directories of with-test-home.sh.
  readonly tmpDir: string;

  readonly procRoot: string;
  readonly ownPID: number;
  readonly nowMs: number;
}

const runDirectoryPrefix = 'atc-test-home-';

// A run directory with no owner file belongs to a run in its first instant, before the script
// writes the file, or to a run of a script that predates the file.
const unownedGraceMs = 60 * 60 * 1000;

export async function removeStaleTestHomes(
  options: Readonly<StaleTestHomesOptions>,
): Promise<string[]> {
  const entries = await readdir(options.tmpDir, { withFileTypes: true });

  const removed: string[] = [];

  for (const entry of entries) {
    const root = join(options.tmpDir, entry.name);

    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(runDirectoryPrefix) ||
      !(await probeStaleRun(root, options))
    ) {
      continue;
    }

    await stopTestHomeProcesses({ root, procRoot: options.procRoot, ownPID: options.ownPID });

    // A concurrent sweep may remove it first.
    await rm(root, { recursive: true, force: true });

    removed.push(root);
  }

  return removed;
}

async function probeStaleRun(
  root: string,
  options: Readonly<StaleTestHomesOptions>,
): Promise<boolean> {
  const owner = await readFile(join(root, 'owner.pid'), 'utf8').catch((error: unknown) =>
    isMissingFileError(error) ? null : undefined,
  );

  // Another user's run directory refuses the read.
  if (owner === undefined) {
    return false;
  }

  if (owner === null) {
    const info = await stat(root).catch(() => null);

    return info !== null && options.nowMs - info.mtimeMs > unownedGraceMs;
  }

  return !(await probeProcessAlive(Number(owner.trim()), options.procRoot));
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function probeProcessAlive(pid: number, procRoot: string): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM means the process runs under another user.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }

  // A killed owner that its parent has not reaped yet still answers the signal, as a zombie.
  const status = await readFile(join(procRoot, String(pid), 'stat'), 'utf8').catch(() => null);

  return (
    status === null ||
    status.slice(status.lastIndexOf(')') + 2, status.lastIndexOf(')') + 3) !== 'Z'
  );
}

// parseArgs throws on an option it does not declare, which the caller reports as a refused input.
function parseCLIArgs(args: readonly string[]): string | Error {
  try {
    const parsed = parseArgs({ args: [...args], options: {}, allowPositionals: true });
    const positionals = parsed.positionals;
    const [tmpDir] = positionals;

    return positionals.length === 1 && tmpDir !== undefined && tmpDir !== ''
      ? tmpDir
      : new Error('pass the temporary folder as the only argument');
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

if (import.meta.main) {
  const tmpDir = parseCLIArgs(process.argv.slice(2));

  if (tmpDir instanceof Error) {
    process.stderr.write(`remove-stale-test-homes: ${tmpDir.message}\n`);
    process.exit(2);
  }

  await removeStaleTestHomes({
    tmpDir,
    procRoot: '/proc',
    ownPID: process.pid,
    nowMs: Date.now(),
  });
}
