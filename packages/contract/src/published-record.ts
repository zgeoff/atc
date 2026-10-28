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

  // The session's name, or null in a record an older atc stored and has
  // not changed since.
  readonly name: string | null;

  // The agent's transcript file on the session's host, or null until the
  // agent reports one.
  readonly transcriptPath: string | null;

  // The atc session the spawn came from, or null for a spawn from outside
  // every session and in a record an older atc stored.
  readonly spawner: string | null;

  // The session's scratch folder on its host, or null for an agent that
  // gives its sessions none and in a record an older atc stored.
  readonly scratch: string | null;
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
