import { parsePushedRefs } from './parse-pushed-refs.ts';
import type { ReadBranchBaseOptions } from './read-branch-base.ts';
import { readBranchBase, readDefaultBranch } from './read-branch-base.ts';
import type { CommitRange } from './read-range-commits.ts';

export interface PushedRangesOptions extends ReadBranchBaseOptions {
  // The lines git hands a pre-push hook on stdin, or null outside a push.
  readonly pushedRefs: string | null;
}

export function readPushedRanges(options: Readonly<PushedRangesOptions>): CommitRange[] {
  if (options.pushedRefs === null) {
    const base = readBranchBase(options);

    return [[`${base}..HEAD`]];
  }

  const refs = parsePushedRefs(options.pushedRefs);

  if (refs.length === 0) {
    return [];
  }

  const defaultBranch = readDefaultBranch(options);

  if (!probeCommitPresent(options, defaultBranch)) {
    throw new Error(
      `cannot find origin's default branch: ${defaultBranch} is not a commit (is the remote fetched?)`,
    );
  }

  return refs.map((ref) =>
    ref.remoteSha !== null && probeCommitPresent(options, ref.remoteSha)
      ? [ref.localSha, `^${defaultBranch}`, `^${ref.remoteSha}`]
      : [ref.localSha, `^${defaultBranch}`],
  );
}

// A remote ref that another clone moved points at a commit this clone may lack.
function probeCommitPresent(options: Readonly<ReadBranchBaseOptions>, revision: string): boolean {
  const result = options.runProgram(['git', 'cat-file', '-e', `${revision}^{commit}`], {
    cwd: options.cwd,
    env: options.env,
  });

  return result.exitCode === 0;
}
