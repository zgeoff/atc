import type { RecordedScope } from '../protocol/published-record';
import type { CheckedScope } from './check-session-scope';

/**
 * Adds each checked entry the recorded scope lacks, keeping the order the
 * entries arrived in. A worktree matches by path, a branch by name and
 * repository, and a pull request by repository and number. Returns the
 * recorded scope itself when every entry is already there.
 */
export function mergeRecordedScope(recorded: RecordedScope, added: CheckedScope): RecordedScope {
  const worktrees = mergeEntries(recorded.worktrees, added.worktrees, (w) => w.path);
  const branches = mergeEntries(recorded.branches, added.branches, (b) => `${b.repo}\n${b.name}`);

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
