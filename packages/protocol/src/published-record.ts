export interface PublishedRecord {
  readonly format: 'atc.session-record';
  readonly version: 1;
  readonly session: string;
  readonly daemonID: string;
  readonly target: string;

  // Starts at 1 and grows by one with each change to the record.
  readonly revision: number;

  // When atc last changed the record, as an ISO 8601 UTC time.
  readonly updatedAt: string;
  readonly scope: RecordedScope;
}

export interface RecordedScope {
  readonly workspace: RecordedWorkspace;
  readonly worktrees: readonly RecordedWorktree[];
  readonly branches: readonly RecordedBranch[];
  readonly pullRequests: readonly RecordedPullRequest[];
}

interface RecordedWorkspace {
  readonly path: string;
  readonly branch: string | null;
  readonly repoURL: string | null;
  readonly sha: string | null;
}

export interface RecordedWorktree {
  readonly path: string;
  readonly branch: string | null;
}

export interface RecordedBranch {
  readonly name: string;

  // The repository directory on the session's host the branch exists in.
  readonly repo: string;
}

export interface RecordedPullRequest {
  // The GitHub repository the pull request belongs to, as `owner/name`.
  readonly repo: string;
  readonly number: number;
  readonly url: string;

  // The pull request's head branch.
  readonly branch: string;
}
