import type { RecordedScope } from '@atc/protocol';
import type { CheckedScope } from './check-session-scope';

export function mergeRecordedScope(recorded: RecordedScope, added: CheckedScope): RecordedScope {
  const worktrees = mergeEntries(recorded.worktrees, added.worktrees, (worktree) => worktree.path);

  const branches = mergeEntries(
    recorded.branches,
    added.branches,
    (branch) => `${branch.repo}\n${branch.name}`,
  );

  const pullRequests = mergeEntries(
    recorded.pullRequests,
    added.pullRequests,
    (pr) => `${pr.repo.toLowerCase()}#${pr.number}`,
  );

  if (
    worktrees === recorded.worktrees &&
    branches === recorded.branches &&
    pullRequests === recorded.pullRequests
  ) {
    return recorded;
  }

  return { workspace: recorded.workspace, worktrees, branches, pullRequests };
}

function mergeEntries<T>(
  recorded: readonly T[],
  added: readonly T[],
  toKey: (entry: T) => string,
): readonly T[] {
  const seen = new Set(recorded.map((entry) => toKey(entry)));

  const fresh: T[] = [];

  for (const entry of added) {
    const key = toKey(entry);

    if (!seen.has(key)) {
      seen.add(key);
      fresh.push(entry);
    }
  }

  return fresh.length === 0 ? recorded : [...recorded, ...fresh];
}
