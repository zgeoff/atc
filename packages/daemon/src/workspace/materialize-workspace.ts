import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createStepTimer, systemClock } from '@atc/core';
import { EffectRemainsError } from '@atc/plugin-api';
import type { SessionWorkspace, SpawnWorkspaceSource } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import type { ErrorCode } from '@atc/protocol/wire';
import type { MaterializationPhase } from '@atc/store';
import { claimLanding } from './claim-landing';
import { createCheckout } from './create-checkout';
import type { MaterializationProgress, ProgressTracker } from './materialization-progress';
import type { Landing, MaterializeDeps } from './materialize-deps';
import type { MaterializeRequest } from './materialize-request';
import { readCredentialSecret } from './read-credential-secret';
import type { GitIdentity } from './read-host-git-identity';
import { recordPhase } from './record-phase';
import { requireGitTransports } from './require-git-transports';
import { requireStartFailure } from './require-start-failure';
import { resolveSource } from './resolve-source';
import { runGit } from './run-git';
import { toDaemonError } from './to-daemon-error';
import { verifyTargetHead } from './verify-target-head';

interface ReadyWorkspace {
  readonly kind: 'ready';
  readonly workspace: SessionWorkspace;

  // The branch the checkout is on, null for a detached checkout.
  readonly branch: string | null;
  readonly warnings: readonly string[];

  // The variables every harness the session starts goes without.
  readonly withheldEnv: readonly string[];
}

type MaterializedWorkspace = { readonly kind: 'in_place' } | ReadyWorkspace;

export async function materializeWorkspace(
  request: MaterializeRequest,
  deps: MaterializeDeps,
): Promise<MaterializedWorkspace> {
  const source = request.source;

  const outside =
    source.kind === 'path' && request.inPlace ? await probeOutsideWorkTree(source.path) : false;

  if (source.kind === 'path' && outside) {
    if (resolve(source.path) !== resolve(request.dir)) {
      throw new DaemonError(
        'bad_args',
        `${source.path} is outside any git work tree, so the session runs in it as it stands; spawn with it as cwd`,
        { phase: 'resolving' },
      );
    }

    return { kind: 'in_place' };
  }

  const secret = readCredentialSecret(source);
  const withheldEnv = buildWithheldEnv(source);
  const progress: MaterializationProgress = { phase: 'resolving', landing: null, claimed: false };

  const updateProgress = (update: Readonly<Partial<MaterializationProgress>>) => {
    Object.assign(progress, update);
  };

  // every phase is recorded before it starts, so a daemon that stops partway leaves a row the
  // next start fails as interrupted
  await deps.store.createMaterialization(
    {
      sessionID: request.sessionID,
      target: request.target,
      directory: request.dir,
      sourceKind: source.kind,
      withheldEnv,
    },
    (deps.clock ?? systemClock).now(),
  );

  // The staging directory exists only once the row does, and only inside
  // the block that removes it, so neither can outlive a failure of the other.
  try {
    const staging = await mkdtemp(join(deps.stagingRoot, 'atc-workspace-'));

    try {
      const ready = await runMaterialization(request, deps, staging, updateProgress, secret);

      return { ...ready, withheldEnv };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } catch (error) {
    const refusal = toScrubbedRefusal(error, progress.phase, secret);

    // A failure that may have left an effect standing, such as a host the
    // spawn could not take back, reaches the caller as it is, so a keyed
    // spawn keeps its key as outcome_unknown.
    const remains = error instanceof EffectRemainsError;
    const code = remains ? 'outcome_unknown' : refusal.code;

    const left = await tryRemoveClaimedDir(request, deps, progress, secret);

    await tryUpdateFailed(request, deps, code);

    deps.log(
      `atc: workspace for session ${request.sessionID} failed while ${progress.phase}: ${code}: ${refusal.message}`,
    );

    if (remains) {
      throw error;
    }

    // A directory the failure left is reported, so the caller can remove it.
    throw left === null
      ? refusal
      : new DaemonError(refusal.code, refusal.message, { ...refusal.data, leftDir: left });
  }
}

// only git's own answer that no repository holds the path proves it is outside one: any other
// failure, such as a broken config or an untrusted repository, refuses the spawn rather than
// run it in place unchecked
async function probeOutsideWorkTree(path: string): Promise<boolean> {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: path }).catch(
    requireStartFailure,
  );

  if (inside === null || inside.exitCode === 0) {
    return false;
  }

  if (inside.stderr.startsWith('fatal: not a git repository')) {
    return true;
  }

  throw new DaemonError(
    'unreadable_tree',
    `git cannot inspect ${path}: ${inside.stderr.trim().split('\n')[0] ?? ''}`,
    { phase: 'resolving' },
  );
}

// a harness inherits the daemon's environment, so the session withholds from every harness
// it starts the git source's credential variable and the askpass variables the clone hands
// its network commands
const ASKPASS_ENV = ['GIT_ASKPASS', 'ATC_GIT_ASKPASS_SECRET'];

function buildWithheldEnv(source: SpawnWorkspaceSource): string[] {
  return source.kind === 'git' && source.credentialRef !== undefined
    ? [source.credentialRef.name, ...ASKPASS_ENV]
    : [...ASKPASS_ENV];
}

async function runMaterialization(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  staging: string,
  updateProgress: ProgressTracker,
  secret: string | null,
): Promise<Omit<ReadyWorkspace, 'withheldEnv'>> {
  const transports = requireGitTransports(deps.gitTransports, { phase: 'resolving' });
  const timer = deps.timer ?? createStepTimer();

  const pinned = await timer.withStep('resolve-source', () =>
    resolveSource(request.source, staging, transports),
  );

  // What is recorded and returned is scrubbed of the credential, even
  // where a caller's own ref happens to spell it.
  const repoURL = secret === null ? pinned.repoURL : toRedacted(pinned.repoURL, secret);
  const ref = secret === null || pinned.ref === null ? pinned.ref : toRedacted(pinned.ref, secret);

  const landing = await claimLanding(request, deps, updateProgress, timer);

  await recordPhase(request, deps, updateProgress, 'cloning', {
    repoURL,
    ref,
    ...(request.autoDir === true ? { directory: landing.dir } : {}),
  });

  const cloned = await createCheckout(
    request,
    deps,
    updateProgress,
    pinned,
    landing,
    staging,
    transports,
    timer,
  );

  if (deps.gitIdentity !== undefined && deps.gitIdentity !== null) {
    const identity = deps.gitIdentity;

    await timer.withStep('identity', () => writeGitIdentity(deps, landing, identity));
  }

  await recordPhase(request, deps, updateProgress, 'verifying', { sha: cloned.sha });

  await timer.withStep('verify', () => verifyTargetHead(request, deps, landing, cloned.sha));

  const materializedAt = (deps.clock ?? systemClock).now();

  await recordPhase(request, deps, updateProgress, 'ready', { materializedAt });

  return {
    kind: 'ready',
    workspace: {
      repoURL,
      sha: cloned.sha,
      ...(ref === null ? {} : { ref }),
      materializedAt,
    },
    branch: cloned.branch,
    warnings: pinned.warnings,
  };
}

function toRedacted(text: string, secret: string): string {
  return text.replaceAll(secret, '[credential]');
}

// Writes the identity into the checkout's own config file, passing each
// value as its own argument so no shell reads it.
async function writeGitIdentity(
  deps: MaterializeDeps,
  landing: Landing,
  identity: GitIdentity,
): Promise<void> {
  const entries = [
    ['user.name', identity.name],
    ['user.email', identity.email],
  ] as const;

  for (const [key, value] of entries) {
    // Sequential: both writes lock the same config file.
    const written = await deps.requireProvider('run').runCommand({
      argv: ['git', 'config', '--file', '.git/config', key, value],
      cwd: landing.dir,
      host: landing.host,
    });

    if (written.exitCode !== 0) {
      const reason = written.stderr.trim().split('\n')[0] ?? '';

      throw new DaemonError(
        'transfer_failed',
        `cannot set ${key} in the checkout on its target: ${reason}`,
        { phase: 'cloning' },
      );
    }
  }
}

// The refusal a failure becomes, with the credential's value scrubbed from
// its message and every string in its data.
function toScrubbedRefusal(
  error: unknown,
  phase: MaterializationPhase,
  secret: string | null,
): DaemonError {
  const refusal = toDaemonError(error, 'internal', phase);

  if (secret === null) {
    return refusal;
  }

  const data =
    refusal.data === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(refusal.data).map(([key, value]) => [
            key,
            typeof value === 'string' ? toRedacted(value, secret) : value,
          ]),
        );

  return new DaemonError(refusal.code, toRedacted(refusal.message, secret), data);
}

// a directory left behind blocks the next materialization into it with `workspace_exists`
// until an operator removes it
async function tryRemoveClaimedDir(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  progress: Readonly<MaterializationProgress>,
  secret: string | null,
): Promise<string | null> {
  if (!progress.claimed || progress.landing === null) {
    return null;
  }

  const dir = progress.landing.dir;

  try {
    const removed = await deps.removeClaim(dir);

    if (removed) {
      return null;
    }

    deps.log(
      `atc: left ${dir} on target '${request.target}' after its workspace for session ${request.sessionID} failed: another session's directory lies inside it, or it no longer resolves to itself; remove it by hand`,
    );
  } catch (error) {
    const reason = toScrubbedRefusal(error, progress.phase, secret).message;

    deps.log(
      `atc: left ${dir} on target '${request.target}' after its workspace for session ${request.sessionID} failed, since removing it failed: ${reason}; remove it by hand`,
    );
  }

  return dir;
}

async function tryUpdateFailed(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  code: ErrorCode,
): Promise<void> {
  try {
    await deps.store.updateMaterialization(
      request.sessionID,
      { phase: 'failed', errorCode: code },
      (deps.clock ?? systemClock).now(),
    );
  } catch {
    // A row left short of failed is failed as interrupted at the next start.
  }
}
