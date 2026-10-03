import { createGitAskpass } from './create-git-askpass';
import type { GitCredential } from './create-git-askpass';
import { runGit } from './run-git';

export interface RemoteRef {
  // The short name: `main`, `feat/x`, `v1.0`.
  readonly name: string;
  readonly kind: 'branch' | 'tag';

  // The commit the ref points at; an annotated tag's is the commit it
  // peels to.
  readonly sha: string;
}

interface RemoteRefListing {
  readonly ok: true;

  // The branch the upstream's HEAD points at, or null when it reports none.
  readonly head: string | null;
  readonly refs: readonly RemoteRef[];

  // Every listed ref by full name, each annotated tag's peeled `^{}` entry
  // beside it, for resolving one ref the way a clone does.
  readonly byName: ReadonlyMap<string, string>;
}

interface RemoteRefRefusal {
  readonly ok: false;
  readonly code: 'clone_failed' | 'credential_missing';
  readonly message: string;
}

/**
 * Lists an upstream's branches and tags and the branch its HEAD points at,
 * through one `git ls-remote` that authenticates exactly as a clone of the
 * same URL does: through the host's git config, or through a private
 * askpass helper for an env credential. git never prompts. A listing git
 * cannot read is refused as `clone_failed` with git's own message.
 */
export async function collectRemoteRefs(
  url: string,
  credential: GitCredential | undefined,
): Promise<RemoteRefListing | RemoteRefRefusal> {
  const askpass = await createGitAskpass(credential);

  if (!askpass.ok) {
    return askpass;
  }

  let listed: Awaited<ReturnType<typeof runGit>>;

  try {
    listed = await runGit(
      [...askpass.args, 'ls-remote', '--symref', '--', url, 'HEAD', 'refs/heads/*', 'refs/tags/*'],
      { env: askpass.env },
    );
  } finally {
    await askpass[Symbol.asyncDispose]();
  }

  if (listed.exitCode !== 0) {
    return { ok: false, code: 'clone_failed', message: listed.stderr.trim() };
  }

  return parseListing(listed.stdout);
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
