import type { RunProgram } from './run-program.ts';

// The revisions of one `git rev-list` call, such as `['<local sha>', '^origin/main']`.
export type CommitRange = readonly string[];

export interface ReadRangeCommitsOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runProgram: RunProgram;
}

// Two ranges can share a commit, such as two branches that start from the same one, and git log
// cannot read a union of ranges, so each range is listed apart and each commit kept once.
export function readRangeCommits(
  options: Readonly<ReadRangeCommitsOptions>,
  ranges: readonly CommitRange[],
): string[] {
  const commits = ranges.flatMap((range) => {
    const argv = ['git', 'rev-list', ...range];
    const result = options.runProgram(argv, { cwd: options.cwd, env: options.env });

    if (result.exitCode !== 0) {
      throw new Error(`${argv.join(' ')} failed: ${result.stderr.trim()}`);
    }

    return result.stdout.split('\n').filter((line) => line !== '');
  });

  return [...new Set(commits)];
}
