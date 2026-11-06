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

  // The owner listed, or null for every repository the gh account can access.
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

  // The account or organization to list; null lists every repository the gh
  // account can access: its own, and those it reaches as a collaborator or an
  // organization member.
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

export async function readGitHubRepos(
  request: GitHubListRequest,
): Promise<GitHubRepoListing | GitHubUnavailable> {
  const timeoutMs = request.timeoutMs ?? GH_TIMEOUT_MS;
  const gh = { run: request.run, bin: request.bin, timeoutMs };

  const listed =
    request.owner === null
      ? await readAccessibleRepos(gh)
      : await readGHJSON(
          gh,
          [
            'repo',
            'list',
            request.owner,
            '--limit',
            String(REPO_LIMIT),
            '--json',
            'nameWithOwner,description,isPrivate,url,sshUrl',
          ],
          REPO_LIST_SCHEMA,
        );

  if (!listed.ok) {
    return listed;
  }

  return {
    ok: true,
    owner: request.owner,
    repos: listed.value,
    gitProtocol: await readGitProtocol(request.run, request.bin, timeoutMs),
  };
}

interface ReadJSON<T> {
  readonly ok: true;
  readonly value: T;
}

interface GHCommand {
  readonly run: HostServices['runCommand'];
  readonly bin: string;
  readonly timeoutMs: number;
}

// The repositories one page of the REST API holds at most.
const PAGE_SIZE = 100;

// The fields of each repository a page of gh api user/repos prints, as a
// listing keeps them.
const USER_REPOS_PAGE_SCHEMA = z.array(
  z
    .object({
      full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
      description: z.string().nullable(),
      private: z.boolean(),
      html_url: z.string(),
      ssh_url: z.string(),
    })
    .transform((repo): GitHubRepo => ({
      nameWithOwner: repo.full_name,
      description: repo.description ?? '',
      isPrivate: repo.private,
      url: repo.html_url,
      sshUrl: repo.ssh_url,
    })),
);

// `gh api --paginate` reads every page before it prints any, with no limit,
// so the pages are read one at a time up to the listing's limit.
async function readAccessibleRepos(
  gh: GHCommand,
): Promise<ReadJSON<readonly GitHubRepo[]> | GitHubUnavailable> {
  const repos: GitHubRepo[] = [];

  for (let page = 1; page <= REPO_LIMIT / PAGE_SIZE; page += 1) {
    const read = await readGHJSON(
      gh,
      [
        'api',
        `user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=${PAGE_SIZE}&page=${page}`,
      ],
      USER_REPOS_PAGE_SCHEMA,
    );

    if (!read.ok) {
      return read;
    }

    repos.push(...read.value);

    if (read.value.length < PAGE_SIZE) {
      break;
    }
  }

  return { ok: true, value: repos };
}

async function readGHJSON<T>(
  gh: GHCommand,
  args: readonly string[],
  schema: z.ZodType<T>,
): Promise<ReadJSON<T> | GitHubUnavailable> {
  const ran = await runGH(gh.run, gh.bin, AbortSignal.timeout(gh.timeoutMs), args);

  if (ran.timedOut) {
    return {
      ok: false,
      code: 'github_unavailable',
      problem: 'failed',
      message: `gh did not answer within ${gh.timeoutMs / 1000} s`,
    };
  }

  if (ran.exitCode !== 0) {
    return buildUnavailable(ran, gh.bin);
  }

  const parsed = schema.safeParse(parseJSON(ran.stdout));

  if (!parsed.success) {
    return {
      ok: false,
      code: 'github_unavailable',
      problem: 'failed',
      message: `gh ${formatCommandName(args)} printed no repository list`,
    };
  }

  return { ok: true, value: parsed.data };
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

// The gh command and its subcommand or API path, without the query.
function formatCommandName(args: readonly string[]): string {
  return args.slice(0, 2).join(' ').split('?')[0] ?? '';
}
