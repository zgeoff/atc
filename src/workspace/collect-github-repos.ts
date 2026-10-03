import { z } from 'zod';

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

/**
 * Lists one owner's GitHub repositories through the gh CLI on this host,
 * as the gh account signed in there sees them. gh is optional: a host
 * without it, or with gh signed out, is refused as `github_unavailable`
 * with the problem, and any other gh failure carries gh's own message. A gh
 * that takes longer than the time limit, 20 s unless given, is refused as
 * failed. gh never prompts here.
 */
export async function collectGitHubRepos(
  request: GitHubListRequest,
): Promise<GitHubRepoListing | GitHubUnavailable> {
  const bin = Bun.which(request.bin);

  if (bin === null) {
    return {
      ok: false,
      code: 'github_unavailable',
      problem: 'not_installed',
      message: `gh is not installed on the daemon host (no '${request.bin}' on PATH)`,
    };
  }

  const timeoutMs = request.timeoutMs ?? GH_TIMEOUT_MS;

  const listed = await runGH(bin, timeoutMs, [
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
    return buildUnavailable(listed);
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

  const protocol = await runGH(bin, timeoutMs, ['config', 'get', 'git_protocol']);

  return {
    ok: true,
    owner: request.owner ?? repos[0]?.nameWithOwner.split('/')[0] ?? null,
    repos,
    gitProtocol: protocol.exitCode === 0 && protocol.stdout.trim() === 'ssh' ? 'ssh' : 'https',
  };
}

interface GHRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

// gh reads its own config and the host's environment for its token, and
// is kept from prompting, colouring, or checking for updates.
async function runGH(bin: string, timeoutMs: number, args: readonly string[]): Promise<GHRun> {
  const proc = Bun.spawn([bin, ...args], {
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_SPINNER_DISABLED: '1',
      NO_COLOR: '1',
      LC_ALL: 'C',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const finished = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const limit = Promise.withResolvers<null>();

  const timer = setTimeout(() => {
    limit.resolve(null);
  }, timeoutMs);

  const settled = await Promise.race([finished, limit.promise]);

  clearTimeout(timer);

  if (settled === null) {
    proc.kill();

    return { exitCode: -1, stdout: '', stderr: '', timedOut: true };
  }

  const [stdout, stderr, exitCode] = settled;

  return { exitCode, stdout, stderr, timedOut: false };
}

// gh exits 4 when it needs a sign-in it does not have.
const GH_AUTH_EXIT = 4;

function buildUnavailable(run: GHRun): GitHubUnavailable {
  const detail = run.stderr.trim();

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
