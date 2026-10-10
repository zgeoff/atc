// Prints, one per line, the files the current branch changes against the
// remote default branch, leaving out deleted files. A branch with no commits
// of its own prints nothing. Exits 1 with a message when no base commit can
// be found, so a hook never checks nothing by accident.
import { resolve } from 'node:path';

interface CollectBranchFilesOptions {
  readonly cwd: string;

  // The whole environment of the git runs; left out, they inherit this process's.
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Returns the paths changed between the merge base of HEAD and the remote
 * default branch, and HEAD, relative to the repository root. The default
 * branch comes from origin/HEAD and falls back to origin/main when origin/HEAD
 * is unset. Throws when there is no origin or no common ancestor.
 */
export async function collectBranchFiles(
  options: Readonly<CollectBranchFilesOptions>,
): Promise<string[]> {
  const head = await runGit(options, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);

  const defaultBranch = head.exitCode === 0 ? head.stdout.trim() : 'origin/main';

  const base = await runGit(options, ['merge-base', 'HEAD', defaultBranch]);

  if (base.exitCode !== 0) {
    throw new Error(
      `cannot find the base of this branch: no merge base between HEAD and ${defaultBranch} (is the remote fetched?)`,
    );
  }

  const diff = await runGit(options, [
    'diff',
    '--name-only',
    '--diff-filter=d',
    base.stdout.trim(),
    'HEAD',
  ]);

  if (diff.exitCode !== 0) {
    throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  }

  return diff.stdout.split('\n').filter((line) => line !== '');
}

async function runGit(options: Readonly<CollectBranchFilesOptions>, args: readonly string[]) {
  const proc = Bun.spawn(['git', ...args], {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

async function main(): Promise<void> {
  try {
    const files = await collectBranchFiles({ cwd: resolve('.') });

    if (files.length > 0) {
      process.stdout.write(`${files.join('\n')}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `collect-branch-files: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
