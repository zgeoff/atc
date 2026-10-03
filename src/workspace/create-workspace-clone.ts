import { rm } from 'node:fs/promises';
import { checkWorkspaceCompleteness } from './check-workspace-completeness';
import { createGitAskpass } from './create-git-askpass';
import type { GitCredential } from './create-git-askpass';
import { findRemoteRef } from './find-remote-ref';
import { runGit } from './run-git';
import type { WorkspaceSource } from './workspace-source';

interface CloneRequest {
  readonly source: Extract<WorkspaceSource, { readonly kind: 'git' }>;
  readonly dir: string;
  readonly credential?: GitCredential;
}

interface CreatedClone {
  readonly ok: true;
  readonly sha: string;
  readonly branch: string | null;
}

interface CloneRefusal {
  readonly ok: false;
  readonly code: 'credential_missing' | 'ref_not_found' | 'clone_failed';
  readonly message: string;
}

type IncompleteCheckout = Exclude<
  Awaited<ReturnType<typeof checkWorkspaceCompleteness>>,
  { readonly ok: true }
>;

/**
 * Clones a repository into an empty directory and checks out the commit its
 * ref points at that moment. A branch ref is checked out as that branch; a tag
 * or a full commit id leaves HEAD detached at the commit. The clone copies
 * objects rather than hard-linking them, takes no hook templates, and runs no
 * hooks on checkout.
 *
 * A ref, or a full commit id, that the upstream does not have is refused as
 * `ref_not_found`, and the directory is removed.
 *
 * The checked-out commit must be the whole workspace: one that uses
 * submodules or tracks paths through Git LFS is refused and the directory is
 * removed. The clone fetches without checking out, and the checkout then
 * runs isolated from the host's system and global git config, so no filter
 * the host configured, LFS or otherwise, runs or reaches the network.
 *
 * Without a credential, git authenticates through the host's own git
 * config. An env credential is read from the named variable and handed to git
 * only through a private askpass helper for the network commands, never
 * through the command line or the URL, and the helper is deleted before this
 * returns. The host's credential helpers are switched off for those commands
 * so none of them stores the token.
 */
export async function createWorkspaceClone(
  request: CloneRequest,
): Promise<CloneRefusal | CreatedClone | IncompleteCheckout> {
  const askpass = await createGitAskpass(request.credential);

  if (!askpass.ok) {
    return askpass;
  }

  try {
    return await createCloneAtRef(request, askpass.env, askpass.args);
  } finally {
    await askpass[Symbol.asyncDispose]();
  }
}

async function createCloneAtRef(
  request: CloneRequest,
  env: Readonly<Record<string, string>>,
  args: readonly string[],
): Promise<CloneRefusal | CreatedClone | IncompleteCheckout> {
  const target = await resolveRef(request.source, env, args);

  if (!target.ok) {
    return target;
  }

  const clone = await runGit(
    [
      ...args,
      'clone',
      '--quiet',
      '--no-local',
      '--no-hardlinks',
      '--no-checkout',
      '--template=',
      '--',
      request.source.url,
      request.dir,
    ],
    { env },
  );

  if (clone.exitCode !== 0) {
    return { ok: false, code: 'clone_failed', message: clone.stderr.trim() };
  }

  const checkout = await runGit(
    [
      '-c',
      'core.hooksPath=/dev/null',
      'checkout',
      '--quiet',
      ...(target.branch === null ? ['--detach', target.sha] : ['-B', target.branch, target.sha]),
    ],
    { cwd: request.dir, isolated: true },
  );

  if (checkout.exitCode !== 0) {
    // A pinned commit that no upstream ref reaches never arrives in the
    // clone, so its checkout fails on a commit the upstream does not have.
    const present = await runGit(['cat-file', '-e', `${target.sha}^{commit}`], {
      cwd: request.dir,
      isolated: true,
    });

    await rm(request.dir, { recursive: true, force: true });

    return target.branch === null && present.exitCode !== 0
      ? { ok: false, code: 'ref_not_found', message: `origin has no commit ${target.sha}` }
      : { ok: false, code: 'clone_failed', message: checkout.stderr.trim() };
  }

  const complete = await checkWorkspaceCompleteness(request.dir, target.sha);

  if (!complete.ok) {
    await rm(request.dir, { recursive: true, force: true });

    return complete;
  }

  return { ok: true, sha: target.sha, branch: target.branch };
}

interface ResolvedRef {
  readonly ok: true;
  readonly sha: string;
  readonly branch: string | null;
}

const SHA_PATTERN = /^(?:[\da-f]{40}|[\da-f]{64})$/u;

/**
 * Pins a ref to a commit before cloning, so the checkout is exactly the
 * commit the ref pointed at when asked, whatever lands on the branch meanwhile.
 * A branch wins over a same-named tag, and an annotated tag resolves to the
 * commit it points at.
 */
async function resolveRef(
  source: Extract<WorkspaceSource, { readonly kind: 'git' }>,
  env: Readonly<Record<string, string>>,
  args: readonly string[],
): Promise<CloneRefusal | ResolvedRef> {
  if (SHA_PATTERN.test(source.ref)) {
    return { ok: true, sha: source.ref, branch: null };
  }

  const listed = await runGit(
    [...args, 'ls-remote', '--', source.url, source.ref, `${source.ref}^{}`],
    { env },
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

  if (match !== null) {
    return { ok: true, ...match };
  }

  const name = source.ref.replace(/^refs\/(?:heads|tags)\//u, '');

  return { ok: false, code: 'ref_not_found', message: `origin has no branch or tag '${name}'` };
}
