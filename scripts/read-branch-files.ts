import { readBranchBase } from './read-branch-base.ts';
import type { RunProgram } from './run-program.ts';
import { runProgram } from './run-program.ts';

interface ReadBranchFilesOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runProgram: RunProgram;

  // Lists the paths the branch deletes too, which a check that compares the disk with HEAD needs.
  readonly withDeleted?: boolean;
}

// lefthook's {push_files} lists all of history for a branch with no upstream, so the pre-push
// baseline reads its file list from here.
export function readBranchFiles(options: Readonly<ReadBranchFilesOptions>): string[] {
  const base = readBranchBase(options);

  const diff = options.runProgram(
    [
      'git',
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      ...(options.withDeleted === true ? [] : ['--diff-filter=d']),
      base,
      'HEAD',
    ],
    { cwd: options.cwd, env: options.env },
  );

  if (diff.exitCode !== 0) {
    throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  }

  // -z prints each path as it is, where a newline list would quote a path with a byte past ASCII.
  return diff.stdout.split('\0').filter((path) => path !== '');
}

function runCLI(): void {
  try {
    const files = readBranchFiles({ cwd: process.cwd(), env: process.env, runProgram });

    if (files.length > 0) {
      process.stdout.write(`${files.join('\n')}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `read-branch-files: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    process.exit(1);
  }
}

if (import.meta.main) {
  runCLI();
}
