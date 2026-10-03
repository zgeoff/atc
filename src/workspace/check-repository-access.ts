import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRemoteRefs } from './collect-remote-refs';
import type { RemoteRef } from './collect-remote-refs';
import type { GitCredential } from './create-git-askpass';
import { findRemoteRef } from './find-remote-ref';
import { resolveGitURL } from './resolve-git-url';

interface AccessRequest {
  readonly url: string;

  // At most one: a branch or tag to resolve to its commit, or a full
  // commit id taken as it is.
  readonly ref?: string | undefined;
  readonly sha?: string | undefined;
  readonly credential?: GitCredential | undefined;
}

interface RepositoryAccess {
  readonly ok: true;

  // The URL a workspace spawn from this source clones.
  readonly url: string;
  readonly head: string | null;
  readonly refs: readonly RemoteRef[];

  // The commit the requested ref or sha selects, and the branch it is on;
  // null when the request holds neither.
  readonly resolved: {
    readonly sha: string;
    readonly branch: string | null;
  } | null;
}

interface AccessRefusal {
  readonly ok: false;
  readonly code:
    | 'clone_failed'
    | 'credential_in_url'
    | 'credential_missing'
    | 'invalid_git_url'
    | 'ref_not_found';
  readonly message: string;
}

/**
 * Checks that the daemon's host can read a git workspace source the way a
 * workspace spawn from it would, without cloning: the URL resolves exactly
 * as the materializer resolves it, against the git config of a fresh empty
 * directory, and one `git ls-remote` authenticates exactly as the clone
 * does. A readable upstream answers with its branches, tags, and default
 * branch, and with the commit the requested ref points at now. A full
 * commit id is taken as it is: a listing holds refs, not objects, so only
 * the clone can tell that the upstream lacks it.
 */
export async function checkRepositoryAccess(
  request: AccessRequest,
): Promise<AccessRefusal | RepositoryAccess> {
  const cwd = await mkdtemp(join(tmpdir(), 'atc-repo-access-'));

  try {
    const resolved = await resolveGitURL(request.url, cwd);

    if (!resolved.ok) {
      return resolved;
    }

    const listing = await collectRemoteRefs(resolved.url, request.credential);

    if (!listing.ok) {
      return listing;
    }

    const access = { ok: true, url: resolved.url, head: listing.head, refs: listing.refs } as const;

    if (request.sha !== undefined) {
      return { ...access, resolved: { sha: request.sha, branch: null } };
    }

    if (request.ref === undefined) {
      return { ...access, resolved: null };
    }

    const match = findRemoteRef(listing.byName, request.ref);

    if (match === null) {
      const name = request.ref.replace(/^refs\/(?:heads|tags)\//u, '');

      return { ok: false, code: 'ref_not_found', message: `origin has no branch or tag '${name}'` };
    }

    return { ...access, resolved: match };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
