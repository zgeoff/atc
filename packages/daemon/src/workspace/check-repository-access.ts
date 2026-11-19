import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitCredential } from './create-git-askpass';
import { findRemoteRef } from './find-remote-ref';
import { readRemoteRefs } from './read-remote-refs';
import type { RemoteRef } from './read-remote-refs';
import { resolveGitURL } from './resolve-git-url';

interface AccessRequest {
  readonly url: string;

  readonly ref?: string | undefined;
  readonly sha?: string | undefined;
  readonly credential?: GitCredential | undefined;

  readonly timeoutMs?: number | undefined;

  readonly transports: readonly string[];

  readonly onSpawn?: ((pid: number) => void) | undefined;
}

interface RepositoryAccess {
  readonly ok: true;

  readonly url: string;
  readonly head: string | null;
  readonly refs: readonly RemoteRef[];

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

export async function checkRepositoryAccess(
  request: AccessRequest,
): Promise<AccessRefusal | RepositoryAccess> {
  const cwd = await mkdtemp(join(tmpdir(), 'atc-repo-access-'));

  try {
    const resolved = await resolveGitURL(request.url, cwd, request.transports);

    if (!resolved.ok) {
      return resolved;
    }

    const listing = await readRemoteRefs(resolved.url, {
      credential: request.credential,
      transports: request.transports,
      timeoutMs: request.timeoutMs,
      onSpawn: request.onSpawn,
    });

    if (!listing.ok) {
      return listing;
    }

    const access = { ok: true, url: resolved.url, head: listing.head, refs: listing.refs } as const;

    // A ref listing holds refs, not objects, so it cannot show whether the upstream has this commit.
    // Only a clone can tell, so the sha is taken as given.
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
