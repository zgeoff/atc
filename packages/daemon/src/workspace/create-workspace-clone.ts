import { rm } from 'node:fs/promises';
import { checkWorkspaceCompleteness } from './check-workspace-completeness';
import { createGitAskpass } from './create-git-askpass';
import type { GitCredential } from './create-git-askpass';
import { resolveRemoteRef } from './resolve-remote-ref';
import { runGit } from './run-git';
import type { WorkspaceSource } from './workspace-source';

interface CloneRequest {
  readonly source: Extract<WorkspaceSource, { readonly kind: 'git' }>;
  readonly directory: string;
  readonly credential?: GitCredential;

  // The transports git may fetch over.
  readonly transports: readonly string[];
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
  const target = await resolveRemoteRef(request, env, args);

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
      request.directory,
    ],
    { env, transports: request.transports },
  );

  if (clone.exitCode !== 0) {
    return { ok: false, code: 'clone_failed', message: clone.stderr.trim() };
  }

  // isolated, so no filter the host configured, LFS or otherwise, runs or reaches the network
  const checkout = await runGit(
    [
      '-c',
      'core.hooksPath=/dev/null',
      'checkout',
      '--quiet',
      ...(target.branch === null ? ['--detach', target.sha] : ['-B', target.branch, target.sha]),
    ],
    { cwd: request.directory, isolated: true },
  );

  if (checkout.exitCode !== 0) {
    // A pinned commit that no upstream ref reaches never arrives in the
    // clone, so its checkout fails on a commit the upstream does not have.
    const present = await runGit(['cat-file', '-e', `${target.sha}^{commit}`], {
      cwd: request.directory,
      isolated: true,
    });

    await rm(request.directory, { recursive: true, force: true });

    return present.exitCode === 0
      ? { ok: false, code: 'clone_failed', message: checkout.stderr.trim() }
      : { ok: false, code: 'ref_not_found', message: `origin has no commit ${target.sha}` };
  }

  const complete = await checkWorkspaceCompleteness(request.directory, target.sha);

  if (!complete.ok) {
    await rm(request.directory, { recursive: true, force: true });

    return complete;
  }

  return { ok: true, sha: target.sha, branch: target.branch };
}
