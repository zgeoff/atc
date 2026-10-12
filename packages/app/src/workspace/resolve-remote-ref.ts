import { findRemoteRef } from './find-remote-ref';
import { runGit } from './run-git';
import type { WorkspaceSource } from './workspace-source';

interface RemoteRefRequest {
  readonly source: Extract<WorkspaceSource, { readonly kind: 'git' }>;

  // The transports git may fetch over.
  readonly transports: readonly string[];
}

interface ResolvedRef {
  readonly ok: true;
  readonly sha: string;
  readonly branch: string | null;
}

interface RefRefusal {
  readonly ok: false;
  readonly code: 'ref_not_found' | 'clone_failed';
  readonly message: string;
}

const SHA_PATTERN = /^(?:[\da-f]{40}|[\da-f]{64})$/u;

/**
 * Pins a ref to a commit before cloning, so the checkout is exactly the
 * commit the ref pointed at when asked, whatever lands on the branch meanwhile.
 * A branch wins over a same-named tag, and an annotated tag resolves to the
 * commit it points at. A source already pinned to a commit keeps it, and
 * its ref only decides whether the checkout is on a branch: a ref that
 * names a branch upstream checks the commit out as that branch. `env` and
 * `args` carry the askpass helper of a credential to `git ls-remote`.
 */
export async function resolveRemoteRef(
  request: RemoteRefRequest,
  env: Readonly<Record<string, string>>,
  args: readonly string[],
): Promise<RefRefusal | ResolvedRef> {
  const source = request.source;

  if (SHA_PATTERN.test(source.ref)) {
    return { ok: true, sha: source.ref, branch: null };
  }

  const pinned = source.sha;

  const listed = await runGit(
    [...args, 'ls-remote', '--', source.url, source.ref, `${source.ref}^{}`],
    { env, transports: request.transports },
  );

  if (listed.exitCode !== 0) {
    return { ok: false, code: 'clone_failed', message: listed.stderr.trim() };
  }

  const refs = new Map(
    listed.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [sha = '', name = ''] = line.split('\t');

        return [name, sha] as const;
      }),
  );

  const match = findRemoteRef(refs, source.ref);

  if (pinned !== undefined) {
    return { ok: true, sha: pinned, branch: match?.branch ?? null };
  }

  if (match !== null) {
    return { ok: true, ...match };
  }

  const name = source.ref.replace(/^refs\/(?:heads|tags)\//u, '');

  return { ok: false, code: 'ref_not_found', message: `origin has no branch or tag '${name}'` };
}
