import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { StepTimer } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import { createGuestClone } from './create-guest-clone';
import { createWorkspaceClone } from './create-workspace-clone';
import type { ProgressTracker } from './materialization-progress';
import type { Landing, MaterializeDeps } from './materialize-deps';
import type { MaterializeRequest } from './materialize-request';
import { readWorkspaceTar } from './read-workspace-tar';
import { recordPhase } from './record-phase';
import { resolveRemoteRef } from './resolve-remote-ref';
import type { PinnedSource } from './resolve-source';
import { sanitizeWorkspaceClone } from './sanitize-workspace-clone';
import { toDaemonError } from './to-daemon-error';

// The commit a workspace is checked out at, and the branch it is on, null
// for a detached checkout.
interface Checkout {
  readonly sha: string;
  readonly branch: string | null;
}

// Clones inside the host when it can, and uploads a clone made on the
// daemon's host otherwise.
export async function createCheckout(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  updateProgress: ProgressTracker,
  pinned: PinnedSource,
  landing: Landing,
  staging: string,
  transports: readonly string[],
  timer: StepTimer,
): Promise<Checkout> {
  const onTarget = await tryCreateCloneOnTarget(request, deps, pinned, landing, transports, timer);

  if (onTarget.kind === 'cloned') {
    return onTarget.checkout;
  }

  return transferCleanClone(
    request,
    deps,
    updateProgress,
    onTarget.pinned,
    landing,
    staging,
    transports,
    timer,
  );
}

async function tryCreateCloneOnTarget(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  pinned: PinnedSource,
  landing: Landing,
  transports: readonly string[],
  timer: StepTimer,
): Promise<
  | { readonly kind: 'cloned'; readonly checkout: Checkout }
  | { readonly kind: 'upload'; readonly pinned: PinnedSource }
> {
  if (deps.cloneOnTarget !== true || request.source.kind !== 'git') {
    return { kind: 'upload', pinned };
  }

  if (pinned.credential !== undefined) {
    deps.log(
      `atc: workspace for session ${request.sessionID} is uploaded from the daemon, since its source credential stays on the daemon's host`,
    );

    return { kind: 'upload', pinned };
  }

  const target = await timer.withStep('resolve-ref', () =>
    resolveRemoteRef(
      {
        source: {
          kind: 'git',
          url: pinned.cloneURL,
          ref: pinned.checkout,
          ...(pinned.sha === undefined ? {} : { sha: pinned.sha }),
        },
        transports,
      },
      {},
      [],
    ),
  );

  if (!target.ok) {
    throw new DaemonError(target.code, target.message, { phase: 'cloning' });
  }

  const clone = await timer
    .withStep('guest-clone', () =>
      createGuestClone(deps.requireProvider('run'), {
        host: landing.host,
        dir: landing.dir,
        url: pinned.cloneURL,
        sha: target.sha,
        branch: target.branch,

        // the host holds no ssh key
        transports: transports.filter((transport) => transport !== 'ssh'),
      }),
    )
    .catch((error: unknown) => {
      throw toDaemonError(error, 'transfer_failed', 'cloning');
    });

  if (!clone.ok) {
    deps.log(
      `atc: workspace for session ${request.sessionID} could not clone inside its host, so the daemon uploads it: ${clone.reason}`,
    );

    return { kind: 'upload', pinned: { ...pinned, sha: target.sha } };
  }

  return { kind: 'cloned', checkout: { sha: target.sha, branch: target.branch } };
}

async function transferCleanClone(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  updateProgress: ProgressTracker,
  pinned: PinnedSource,
  landing: Landing,
  staging: string,
  transports: readonly string[],
  timer: StepTimer,
): Promise<Checkout> {
  const clone = await createCleanClone(pinned, join(staging, 'clone'), transports, timer);

  // The archive is in memory, so the clone leaves the daemon's host before
  // the target is touched.
  await rm(staging, { recursive: true, force: true });
  await recordPhase(request, deps, updateProgress, 'transferring', { sha: clone.sha });

  try {
    await timer.withStep('transfer', () =>
      deps.requireProvider('transfer').transferArchive(clone.archive, landing.dir, landing.host),
    );
  } catch (error) {
    throw toDaemonError(error, 'transfer_failed', 'transferring');
  }

  return { sha: clone.sha, branch: clone.branch };
}

interface CleanClone {
  readonly sha: string;
  readonly branch: string | null;
  readonly archive: Uint8Array;
}

async function createCleanClone(
  pinned: PinnedSource,
  dir: string,
  transports: readonly string[],
  timer: StepTimer,
): Promise<CleanClone> {
  const clone = await timer.withStep('clone', () =>
    createWorkspaceClone({
      source: {
        kind: 'git',
        url: pinned.cloneURL,
        ref: pinned.checkout,
        ...(pinned.sha === undefined ? {} : { sha: pinned.sha }),
      },
      dir,
      transports,
      ...(pinned.credential === undefined ? {} : { credential: pinned.credential }),
    }),
  );

  if (!clone.ok) {
    const { ok: _ok, code, message, ...detail } = clone;

    throw new DaemonError(code, message, { phase: 'cloning', ...detail });
  }

  const sanitized = await timer.withStep('sanitize', () =>
    sanitizeWorkspaceClone(dir, pinned.cloneURL),
  );

  if (!sanitized.ok) {
    throw new DaemonError(sanitized.code, sanitized.message, { phase: 'cloning' });
  }

  const read = await timer.withStep('archive', async () => {
    const tar = readWorkspaceTar(dir);

    const bytes = await new Response(tar.stream).arrayBuffer();

    return { archive: new Uint8Array(bytes), outcome: await tar.done };
  });

  const archive = read.archive;
  const outcome = read.outcome;

  if (!outcome.ok) {
    throw new DaemonError(outcome.code, outcome.message, { phase: 'cloning' });
  }

  return { sha: clone.sha, branch: clone.branch, archive };
}
