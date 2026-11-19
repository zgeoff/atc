import { createGitAskpass } from './create-git-askpass';
import type { GitCredential } from './create-git-askpass';
import { runGit } from './run-git';

export interface RemoteRef {
  readonly name: string;
  readonly kind: 'branch' | 'tag';

  readonly sha: string;
}

interface RemoteRefListing {
  readonly ok: true;

  readonly head: string | null;
  readonly refs: readonly RemoteRef[];

  readonly byName: ReadonlyMap<string, string>;
}

interface RemoteRefRefusal {
  readonly ok: false;
  readonly code: 'clone_failed' | 'credential_missing';
  readonly message: string;
}

const REMOTE_TIMEOUT_MS = 20_000;

interface ReadRemoteRefsOptions {
  readonly credential?: GitCredential | undefined;
  readonly transports: readonly string[];
  readonly timeoutMs?: number | undefined;
  readonly onSpawn?: ((pid: number) => void) | undefined;
}

export async function readRemoteRefs(
  url: string,
  options: ReadRemoteRefsOptions,
): Promise<RemoteRefListing | RemoteRefRefusal> {
  const timeoutMs = options.timeoutMs ?? REMOTE_TIMEOUT_MS;

  const askpass = await createGitAskpass(options.credential, url);

  if (!askpass.ok) {
    return askpass;
  }

  let listed: Awaited<ReturnType<typeof runGit>>;

  try {
    const sshEnv = await readSSHTimeoutEnv(timeoutMs);

    listed = await runGit(
      [
        ...askpass.args,
        ...buildHTTPTimeoutArgs(timeoutMs),
        'ls-remote',
        '--symref',
        '--',
        url,
        'HEAD',
        'refs/heads/*',
        'refs/tags/*',
      ],
      {
        env: { ...askpass.env, ...sshEnv },
        timeoutMs,
        transports: options.transports,
        onSpawn: options.onSpawn,
      },
    );
  } finally {
    await askpass[Symbol.asyncDispose]();
  }

  if (listed.timedOut) {
    return {
      ok: false,
      code: 'clone_failed',
      message: `git ls-remote did not answer within ${timeoutMs / 1000} s`,
    };
  }

  if (listed.exitCode !== 0) {
    return { ok: false, code: 'clone_failed', message: listed.stderr.trim() };
  }

  return parseListing(listed.stdout);
}

async function readSSHTimeoutEnv(timeoutMs: number): Promise<Readonly<Record<string, string>>> {
  if (process.env['GIT_SSH_COMMAND'] !== undefined || process.env['GIT_SSH'] !== undefined) {
    return {};
  }

  const configured = await runGit(['config', '--get', 'core.sshCommand']);

  if (configured.exitCode === 0 && configured.stdout.trim() !== '') {
    return {};
  }

  const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));

  return { GIT_SSH_COMMAND: `ssh -o ConnectTimeout=${seconds}` };
}

function buildHTTPTimeoutArgs(timeoutMs: number): string[] {
  const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));

  return ['-c', 'http.lowSpeedLimit=1', '-c', `http.lowSpeedTime=${seconds}`];
}

const SYMREF_PREFIX = 'ref: refs/heads/';

function parseListing(stdout: string): RemoteRefListing {
  const byName = new Map<string, string>();

  let head: string | null = null;

  for (const line of stdout.split('\n')) {
    const [left = '', name = ''] = line.split('\t');

    if (name === 'HEAD' && left.startsWith(SYMREF_PREFIX)) {
      head = left.slice(SYMREF_PREFIX.length);
    } else if (name.startsWith('refs/heads/') || name.startsWith('refs/tags/')) {
      byName.set(name, left);
    }
  }

  const refs: RemoteRef[] = [];

  for (const [name, sha] of byName) {
    if (name.startsWith('refs/heads/')) {
      refs.push({ name: name.slice('refs/heads/'.length), kind: 'branch', sha });
    } else if (!name.endsWith('^{}')) {
      refs.push({
        name: name.slice('refs/tags/'.length),
        kind: 'tag',
        sha: byName.get(`${name}^{}`) ?? sha,
      });
    }
  }

  return { ok: true, head, refs, byName };
}
