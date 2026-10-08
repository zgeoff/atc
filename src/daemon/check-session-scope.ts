import { z } from 'zod';
import { DaemonError } from '../protocol/daemon-error';
import type { DeclaredScope } from '../protocol/parse-declared-scope';
import type {
  RecordedBranch,
  RecordedPullRequest,
  RecordedWorktree,
} from '../protocol/published-record';
import { runGH } from '../sources/github/run-gh';
import type { ExecutionProvider } from './execution-provider';
import { findHostBranch } from './find-host-branch';
import { runHostGit } from './run-host-git';

/**
 * Where a declared scope is checked: the session's host and directory,
 * and the repository URL of its materialized workspace, null for a
 * directory that runs as it stands.
 */
export interface ScopeCheckRequest {
  readonly provider: ExecutionProvider;
  readonly host: string;
  readonly dir: string;
  readonly repoURL: string | null;
  readonly declared: DeclaredScope;
}

export interface CheckedScope {
  readonly worktrees: readonly RecordedWorktree[];
  readonly branches: readonly RecordedBranch[];
  readonly pullRequests: readonly RecordedPullRequest[];
}

// How long one gh call may take before the entry it checks is refused.
const GH_TIMEOUT_MS = 20_000;

/**
 * Checks each declared entry against the session's host and returns what
 * the record holds for it: a worktree's branch as git reads it there, a
 * branch with the repository it exists in, and a pull request as GitHub
 * holds it. The first entry that fails refuses the whole scope with
 * `scope_invalid`, the entry in its message and `data.entry`.
 */
export async function checkSessionScope(
  request: ScopeCheckRequest,
  ghBin: string,
): Promise<CheckedScope> {
  const declared = request.declared;
  const needsHost = declared.worktrees.length > 0 || declared.branches.length > 0;

  if (needsHost && request.provider.remote && !request.provider.capabilities.run) {
    const first = declared.worktrees.length > 0 ? 'scope.worktrees[0]' : 'scope.branches[0]';

    throw buildScopeRefusal(first, 'cannot be checked: the target runs no commands');
  }

  const worktrees: RecordedWorktree[] = [];

  for (const [index, worktree] of declared.worktrees.entries()) {
    const checked = await checkWorktree(request, `scope.worktrees[${index}]`, worktree.path);

    worktrees.push(checked);
  }

  const branches: RecordedBranch[] = [];

  for (const [index, branch] of declared.branches.entries()) {
    const repo = branch.repo ?? request.dir;

    const checked = await checkBranch(request, `scope.branches[${index}]`, branch.name, repo);

    branches.push(checked);
  }

  const pullRequests: RecordedPullRequest[] = [];

  for (const [index, pr] of declared.pullRequests.entries()) {
    const entry = `scope.pullRequests[${index}]`;
    let repo = pr.repo;

    repo ??= await findGitHubRepo(request, entry);

    const checked = await checkPullRequest(entry, repo, pr.number, ghBin);

    pullRequests.push(checked);
  }

  return { worktrees, branches, pullRequests };
}

async function checkWorktree(
  request: ScopeCheckRequest,
  entry: string,
  path: string,
): Promise<RecordedWorktree> {
  const top = await runHostGit(request.provider, request.host, path, [
    'rev-parse',
    '--show-toplevel',
  ]);

  if (top.exitCode !== 0) {
    throw buildScopeRefusal(entry, `${path} is not a git worktree on the session's host`);
  }

  if (top.stdout.trim() !== path.replace(/\/+$/u, '')) {
    throw buildScopeRefusal(
      entry,
      `${path} is inside the worktree ${top.stdout.trim()}, not its top level`,
    );
  }

  return { path, branch: await findHostBranch(request.provider, request.host, path) };
}

async function checkBranch(
  request: ScopeCheckRequest,
  entry: string,
  name: string,
  repo: string,
): Promise<RecordedBranch> {
  const format = await runHostGit(request.provider, request.host, repo, [
    'check-ref-format',
    '--branch',
    name,
  ]);

  if (format.exitCode !== 0) {
    throw buildScopeRefusal(entry, `${name} is not a valid branch name`);
  }

  for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
    const found = await runHostGit(request.provider, request.host, repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);

    if (found.exitCode === 0) {
      return { name, repo };
    }
  }

  throw buildScopeRefusal(entry, `${repo} has no branch ${name}`);
}

// The GitHub repository a pull request defaults to: that of the workspace's
// origin.
async function findGitHubRepo(request: ScopeCheckRequest, entry: string): Promise<string> {
  let url = request.repoURL;

  if (url === null && (!request.provider.remote || request.provider.capabilities.run)) {
    const origin = await runHostGit(request.provider, request.host, request.dir, [
      'remote',
      'get-url',
      'origin',
    ]);

    url = origin.exitCode === 0 ? origin.stdout.trim() : null;
  }

  const repo = url === null ? null : findGitHubRepoInURL(url);

  if (repo === null) {
    throw buildScopeRefusal(entry, "needs a repo: the workspace's origin is not on GitHub");
  }

  return repo;
}

const GITHUB_URL =
  /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)(?<repo>[\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/u;

function findGitHubRepoInURL(url: string): string | null {
  return GITHUB_URL.exec(url)?.groups?.['repo'] ?? null;
}

const BASE_REPO_SCHEMA = z.object({ full_name: z.string() });

const PULL_REQUEST_SCHEMA = z.object({
  number: z.number(),
  html_url: z.string(),
  head: z.object({ ref: z.string() }),
  base: z.object({ repo: BASE_REPO_SCHEMA }),
});

async function checkPullRequest(
  entry: string,
  repo: string,
  number: number,
  ghBin: string,
): Promise<RecordedPullRequest> {
  let run: Awaited<ReturnType<typeof runGH>>;

  try {
    run = await runGH(ghBin, AbortSignal.timeout(GH_TIMEOUT_MS), [
      'api',
      `repos/${repo}/pulls/${number}`,
    ]);
  } catch {
    throw buildScopeRefusal(entry, 'cannot be checked: gh is not installed on the daemon host');
  }

  if (run.timedOut) {
    throw buildScopeRefusal(entry, 'cannot be checked: gh took too long');
  }

  const parsed =
    run.exitCode === 0 ? PULL_REQUEST_SCHEMA.safeParse(tryParseJSON(run.stdout)) : null;

  if (parsed === null || !parsed.success) {
    throw buildScopeRefusal(entry, `${repo} has no pull request #${number}`);
  }

  if (parsed.data.base.repo.full_name.toLowerCase() !== repo.toLowerCase()) {
    throw buildScopeRefusal(
      entry,
      `pull request #${number} belongs to ${parsed.data.base.repo.full_name}, not ${repo}`,
    );
  }

  return { repo, number, url: parsed.data.html_url, branch: parsed.data.head.ref };
}

function tryParseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildScopeRefusal(entry: string, reason: string): DaemonError {
  return new DaemonError('scope_invalid', `${entry} ${reason}`, { entry });
}
