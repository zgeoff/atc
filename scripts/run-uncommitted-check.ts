import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readBranchFiles } from './read-branch-files.ts';
import type { RunProgram } from './run-program.ts';
import { runProgram } from './run-program.ts';

export interface UncommittedCheckOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;

  // The files the push sends or deletes, relative to the repo root.
  readonly files: readonly string[];

  readonly runProgram: RunProgram;
  readonly probeFile: (path: string) => boolean;
}

// The later checks read the disk, so a change to a pushed file that is not committed would hide a
// fault in the pushed commit. A file the branch deletes fails when it is back on disk, even under an
// ignore rule. Each git call lists every path, so no file name reaches its argv.
export function runUncommittedCheck(options: Readonly<UncommittedCheckOptions>): string[] {
  // Each entry is two status letters, a space and the path.
  const changed = new Set(
    runGit(options, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=no'])
      .split('\0')
      .map((entry) => entry.slice(3)),
  );

  const tracked = new Set(
    runGit(options, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', 'HEAD']).split('\0'),
  );

  return options.files.filter(
    (path) =>
      changed.has(path) || (!tracked.has(path) && options.probeFile(join(options.cwd, path))),
  );
}

function runGit(options: Readonly<UncommittedCheckOptions>, args: readonly string[]): string {
  const result = options.runProgram(['git', ...args], { cwd: options.cwd, env: options.env });

  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }

  return result.stdout;
}

function runCLI(): void {
  const cwd = process.cwd();

  try {
    const files = readBranchFiles({ cwd, env: process.env, runProgram, withDeleted: true });

    const changed = runUncommittedCheck({
      cwd,
      env: process.env,
      files,
      runProgram,
      probeFile: existsSync,
    });

    if (changed.length > 0) {
      process.stdout.write(
        `uncommitted: these files the branch changes hold a change that is not committed, so the checks would read a copy the push does not send; commit or stash it:\n${changed.join('\n')}\n`,
      );
    }

    process.exitCode = changed.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `uncommitted: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    process.exitCode = 2;
  }
}

if (import.meta.main) {
  runCLI();
}
