import { runGH } from '@atc/plugin-api';
import type { GHRun, HostServices } from '@atc/plugin-api';
import { z } from 'zod';
import { readGitProtocol } from './read-git-protocol';

interface GitHubRepo {
  // `owner/repo`, which a git workspace source takes as its URL.
  readonly nameWithOwner: string;
  readonly description: string;
  readonly isPrivate: boolean;

  // The repository's https and ssh clone URLs.
  readonly url: string;
  readonly sshUrl: string;
}

interface GitHubRepoListing {
  readonly ok: true;

  // The owner listed: the requested one, else the gh account's own login
  // as the first repository holds it, else null for an empty own list.
  readonly owner: string | null;
  readonly repos: readonly GitHubRepo[];

  // The clone protocol the gh config prefers, `https` unless it says `ssh`.
  readonly gitProtocol: 'https' | 'ssh';
}

interface GitHubUnavailable {
  readonly ok: false;
  readonly code: 'github_unavailable';
  readonly problem: 'failed' | 'not_authenticated' | 'not_installed';
  readonly message: string;
}

interface GitHubListRequest {
  // The host's command runner, which runs gh.
  readonly run: HostServices['runCommand'];

  // The gh executable: a name looked up on PATH, or a path.
  readonly bin: string;

  // The account or organization to list; null lists the gh account's own.
  readonly owner: string | null;

  // How long each gh command may take; 20 s when unset.
  readonly timeoutMs?: number;
}

// How long a gh command may take before the listing is refused.
const GH_TIMEOUT_MS = 20_000;

// How many repositories one listing holds at most.
const REPO_LIMIT = 500;

// The fields of each repository gh repo list prints that a listing keeps.
const REPO_LIST_SCHEMA = z.array(
  z.object({
    nameWithOwner: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
    description: z
      .string()
      .nullable()
      .optional()
      .transform((description) => description ?? ''),
    isPrivate: z.boolean(),
    url: z.string(),
    sshUrl: z.string(),
  }),
);

export async function collectGitHubRepos(
  request: GitHubListRequest,
): Promise<GitHubRepoListing | GitHubUnavailable> {
  const timeoutMs = request.timeoutMs ?? GH_TIMEOUT_MS;

  const listed = await runGH(request.run, request.bin, AbortSignal.timeout(timeoutMs), [
    'repo',
    'list',
    ...(request.owner === null ? [] : [request.owner]),
    '--limit',
    String(REPO_LIMIT),
    '--json',
    'nameWithOwner,description,isPrivate,url,sshUrl',
  ]);

  if (listed.timedOut) {
    return {
      ok: false,
      code: 'github_unavailable',
      problem: 'failed',
      message: `gh did not answer within ${timeoutMs / 1000} s`,
    };
  }

  if (listed.exitCode !== 0) {
    return buildUnavailable(listed, request.bin);
  }

  const parsed = REPO_LIST_SCHEMA.safeParse(parseJSON(listed.stdout));

  if (!parsed.success) {
    return {
      ok: false,
      code: 'github_unavailable',
      problem: 'failed',
      message: 'gh repo list printed no repository list',
    };
  }

  const repos = parsed.data;

  return {
    ok: true,
    owner: request.owner ?? repos[0]?.nameWithOwner.split('/')[0] ?? null,
    repos,
    gitProtocol: await readGitProtocol(request.run, request.bin, timeoutMs),
  };
}

// gh exits 4 when it needs a sign-in it does not have, and the host's
// runner reads a gh that could not start as exit code 127.
const GH_AUTH_EXIT = 4;
const NOT_STARTED_EXIT = 127;

function buildUnavailable(run: GHRun, bin: string): GitHubUnavailable {
  const detail = run.stderr.trim();

  if (run.exitCode === NOT_STARTED_EXIT) {
    return {
      ok: false,
      code: 'github_unavailable',
      problem: 'not_installed',
      message: `gh is not installed on the daemon host (no '${bin}' on PATH)`,
    };
  }

  if (run.exitCode === GH_AUTH_EXIT) {
    return {
      ok: false,
      code: 'github_unavailable',
      problem: 'not_authenticated',
      message: `gh is not signed in on the daemon host; run gh auth login there${detail === '' ? '' : `: ${detail}`}`,
    };
  }

  return {
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: detail === '' ? `gh exited with ${run.exitCode}` : detail,
  };
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
