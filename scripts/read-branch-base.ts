import type { RunProgram } from './run-program.ts';

export interface ReadBranchBaseOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runProgram: RunProgram;
}

export function readBranchBase(options: Readonly<ReadBranchBaseOptions>): string {
  const defaultBranch = readDefaultBranch(options);
  const base = runGit(options, ['merge-base', 'HEAD', defaultBranch]);

  if (base.exitCode !== 0) {
    throw new Error(
      `cannot find the base of this branch: no merge base between HEAD and ${defaultBranch} (is the remote fetched?)`,
    );
  }

  return base.stdout.trim();
}

export function readDefaultBranch(options: Readonly<ReadBranchBaseOptions>): string {
  const head = runGit(options, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);

  // A clone made before origin/HEAD existed, and a CI checkout, have no symbolic ref.
  return head.exitCode === 0 ? head.stdout.trim() : 'origin/main';
}

function runGit(options: Readonly<ReadBranchBaseOptions>, args: readonly string[]) {
  return options.runProgram(['git', ...args], { cwd: options.cwd, env: options.env });
}
