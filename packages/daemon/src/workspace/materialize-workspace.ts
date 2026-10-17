import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { InvalidGitTransports } from '@atc/config';
import { createStepTimer, systemClock } from '@atc/core';
import type { Clock, SessionID, StepTimer } from '@atc/core';
import { EffectRemainsError } from '@atc/plugin-api';
import type { ExecutionProvider } from '@atc/plugin-api';
import type { SessionWorkspace, SpawnWorkspaceSource } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import type { ErrorCode } from '@atc/protocol/wire';
import type { MaterializationPhase, StateStore } from '@atc/store';
import { checkURLCredentials } from './check-url-credentials';
import { createGuestClone } from './create-guest-clone';
import { createWorkspaceClone } from './create-workspace-clone';
import { expandGitShorthand } from './expand-git-shorthand';
import { normalizeGitURL } from './normalize-git-url';
import type { GitIdentity } from './read-host-git-identity';
import { readWorkspaceTar } from './read-workspace-tar';
import { REPOSITORY_ENV_UNSET_ARGV } from './repository-env-unset-argv';
import { requireGitTransports } from './require-git-transports';
import { resolveGitURL } from './resolve-git-url';
import { resolvePathSource } from './resolve-path-source';
import { resolveRemoteRef } from './resolve-remote-ref';
import { runGit } from './run-git';
import { sanitizeWorkspaceClone } from './sanitize-workspace-clone';

interface MaterializeRequest {
  readonly sessionID: SessionID;
  readonly target: string;

  // The directory on the target the workspace lands in; it must not exist.
  readonly dir: string;
  readonly source: SpawnWorkspaceSource;

  // Whether the target is the daemon's own host, where a directory outside
  // any git work tree runs in place instead of being materialized.
  readonly inPlace: boolean;

  // Whether the daemon picked the directory, so one that exists or that
  // another workspace holds moves the claim to the next attempt's
  // directory instead of refusing the spawn.
  readonly autoDir?: boolean;
}

// The host a workspace lands on, and the directory there it is built in.
interface Landing {
  readonly host: string;
  readonly dir: string;
}

interface MaterializeDeps {
  // The target's provider for one operation, after the execution gate
  // passes it; throws the gate's refusal otherwise.
  readonly requireProvider: (capability: 'run' | 'transfer') => ExecutionProvider;
  readonly store: Pick<StateStore, 'createMaterialization' | 'updateMaterialization'>;
  readonly log: (line: string) => void;

  // Readies the host on the target the workspace lands on and resolves to
  // it, once the source has resolved, with the directory of an attempt: the
  // first is the request's directory, and attempt n appends `-n` to it.
  readonly readyHost: (attempt: number) => Promise<Landing>;

  // Removes the directory this call claimed after a failure, and resolves
  // to whether it did; one it leaves holds what another session needs, or
  // no longer resolves to itself.
  readonly removeClaim: (dir: string) => Promise<boolean>;

  // The directory on the daemon's host that holds each clone's staging
  // directory while the workspace is built.
  readonly stagingRoot: string;

  // The transports a source may use and git may fetch over, or the invalid
  // list the config holds, which refuses every source that needs git.
  readonly gitTransports: readonly string[] | InvalidGitTransports;

  // Times each step of the build under its name, for the spawn it is for.
  readonly timer?: StepTimer;

  // Whether a git source is cloned inside the host the workspace lands on,
  // rather than cloned on the daemon's host and transferred there.
  readonly cloneOnTarget?: boolean;

  // The git identity written into the checkout's own config, for a host that
  // holds none of its own; unset or null writes nothing.
  readonly gitIdentity?: GitIdentity | null;

  // The clock each phase of the row is stamped with; the system clock when
  // unset.
  readonly clock?: Clock;
}

type MaterializedWorkspace = { readonly kind: 'in_place' } | ReadyWorkspace;

interface ReadyWorkspace {
  readonly kind: 'ready';
  readonly workspace: SessionWorkspace;

  // The branch the checkout is on, null for a detached checkout.
  readonly branch: string | null;
  readonly warnings: readonly string[];

  // The variables every harness the session starts goes without.
  readonly withheldEnv: readonly string[];
}

interface MaterializationProgress {
  phase: MaterializationPhase;

  // The host the workspace lands on and its directory there, once the
  // host is ready.
  landing: Landing | null;

  // Whether this call created the target directory, so a failure removes
  // only a directory it made.
  claimed: boolean;
}

// Moves a materialization's progress along as each step completes.
type ProgressTracker = (update: Readonly<Partial<MaterializationProgress>>) => void;

export async function materializeWorkspace(
  request: MaterializeRequest,
  deps: MaterializeDeps,
): Promise<MaterializedWorkspace> {
  const source = request.source;

  const outside =
    source.kind === 'path' && request.inPlace ? await isOutsideWorkTree(source.path) : false;

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

  const secret = findCredentialSecret(source);
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
      dir: request.dir,
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

// a harness inherits the daemon's environment, so the session withholds from every harness
// it starts the git source's credential variable and the askpass variables the clone hands
// its network commands
const ASKPASS_ENV = ['GIT_ASKPASS', 'ATC_GIT_ASKPASS_SECRET'];

function buildWithheldEnv(source: SpawnWorkspaceSource): string[] {
  return source.kind === 'git' && source.credentialRef !== undefined
    ? [source.credentialRef.name, ...ASKPASS_ENV]
    : [...ASKPASS_ENV];
}

// only git's own answer that no repository holds the path proves it is outside one: any other
// failure, such as a broken config or an untrusted repository, refuses the spawn rather than
// run it in place unchecked
async function isOutsideWorkTree(path: string): Promise<boolean> {
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

// A git that cannot start, such as one given a cwd that is gone, reads as
// no answer; any refusal, such as git's output that stays open after it
// exits, is thrown on with the resolving phase so it fails the spawn.
function requireStartFailure(error: unknown): null {
  if (error instanceof DaemonError) {
    throw toDaemonError(error, 'internal', 'resolving');
  }

  return null;
}

// The credential's value, which every message leaving this module is
// scrubbed of; null for a source without one.
function findCredentialSecret(source: SpawnWorkspaceSource): string | null {
  if (source.kind !== 'git' || source.credentialRef === undefined) {
    return null;
  }

  const value = process.env[source.credentialRef.name];

  return value === undefined || value === '' ? null : value;
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
    ...(request.autoDir === true ? { dir: landing.dir } : {}),
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

interface PinnedSource {
  // The URL the clone fetches from and the token-free form it is recorded
  // under.
  readonly cloneURL: string;
  readonly repoURL: string;

  // The ref or commit the clone checks out, the commit it is pinned to when
  // the ref only names its branch, and the branch or tag recorded.
  readonly checkout: string;
  readonly sha?: string | undefined;
  readonly ref: string | null;
  readonly credential: { readonly kind: 'env'; readonly name: string } | undefined;
  readonly warnings: readonly string[];
}

async function resolveSource(
  source: SpawnWorkspaceSource,
  staging: string,
  transports: readonly string[],
): Promise<PinnedSource> {
  if (source.kind === 'path') {
    // The origin is checked as configured, before resolving it applies any
    // rewrite: a rewrite the checkout's own config holds expands it too.
    await requireNoOriginRewriteCredentials(source.path);

    const resolved = await resolvePathSource(source.path, {
      ...(source.allowDirty === undefined ? {} : { allowDirty: source.allowDirty }),
      transports,
    });

    if (!resolved.ok) {
      throw new DaemonError(resolved.code, resolved.message, { phase: 'resolving' });
    }

    await requireNoURLCredentials(resolved.url, staging);

    return {
      cloneURL: resolved.url,
      repoURL: resolved.url,
      checkout: resolved.sha,
      ref: resolved.branch,
      credential: undefined,
      warnings: resolved.warnings,
    };
  }

  // A credential the clone would refuse is refused here, before any host
  // is readied for it.
  if (source.credentialRef !== undefined && findCredentialSecret(source) === null) {
    throw new DaemonError(
      'credential_missing',
      'the credential environment variable is unset or empty',
      { phase: 'resolving' },
    );
  }

  // The clone fetches the URL it records, so the spawn API's `owner/repo`
  // shorthand reaches the repository it expands to.
  const resolved = await resolveGitURL(expandGitShorthand(source.url), staging, transports);

  if (!resolved.ok) {
    throw new DaemonError(resolved.code, resolved.message, { phase: 'resolving' });
  }

  return {
    cloneURL: resolved.url,
    repoURL: resolved.url,
    checkout: source.ref ?? source.sha ?? '',
    sha: source.ref === undefined ? undefined : source.sha,
    ref: source.ref ?? null,
    credential: source.credentialRef,
    warnings: [],
  };
}

// a credential the origin itself holds is stripped when the source resolves, so only a
// rewrite is checked here; a checkout with no readable origin is left to resolution to refuse
async function requireNoOriginRewriteCredentials(path: string): Promise<void> {
  const origin = await runGit(['config', '--get', 'remote.origin.url'], { cwd: path }).catch(
    requireStartFailure,
  );

  const normalized = origin?.exitCode === 0 ? normalizeGitURL(origin.stdout) : null;

  if (normalized?.ok === true) {
    await requireNoURLCredentials(normalized.url, path);
  }
}

async function requireNoURLCredentials(url: string, cwd: string): Promise<void> {
  const finding = await checkURLCredentials(url, cwd);

  if (!finding.ok) {
    throw new DaemonError(finding.code, finding.message, { phase: 'resolving' });
  }
}

// How many directories a spawn whose directory the daemon picked tries
// before it refuses.
const AUTO_DIR_ATTEMPTS = 100;

async function claimLanding(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  updateProgress: ProgressTracker,
  timer: StepTimer,
): Promise<Landing> {
  // a picked directory moves to the next attempt while it exists or another workspace holds
  // it, so repeated and concurrent spawns of one repository land side by side
  const attempts = request.autoDir === true ? AUTO_DIR_ATTEMPTS : 1;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const landing = await deps.readyHost(attempt);

      updateProgress({ landing });

      await timer.withStep('dir-create', () =>
        claimTargetDir(request, deps, landing, updateProgress),
      );

      return landing;
    } catch (error) {
      const held =
        error instanceof DaemonError &&
        (error.code === 'workspace_exists' || error.code === 'workspace_overlap');

      if (!held || attempt >= attempts) {
        throw error;
      }
    }
  }
}

// exits with the parent status when the parent cannot be created, with the present status
// when anything, a dangling symlink included, stands at the directory's path, and 5 otherwise
const PARENT_FAILED_EXIT = 3;
const DIR_PRESENT_EXIT = 4;

export const CLAIM_DIR_SCRIPT = `mkdir -p -- "$1" || exit ${PARENT_FAILED_EXIT}
mkdir -- "$2" && exit 0
if [ -e "$2" ] || [ -L "$2" ]; then exit ${DIR_PRESENT_EXIT}; fi
exit 5`;

// `mkdir` without `-p` fails when the directory exists, so a materialization never unpacks
// over files it did not put there
async function claimTargetDir(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  landing: Landing,
  updateProgress: ProgressTracker,
): Promise<void> {
  // A directory the daemon picked is reported as it landed.
  const shown = request.autoDir === true ? landing.dir : request.dir;

  const claim = await deps.requireProvider('run').runCommand({
    argv: ['sh', '-c', CLAIM_DIR_SCRIPT, 'sh', dirname(landing.dir), landing.dir],
    cwd: '/',
    host: landing.host,
  });

  if (claim.exitCode === PARENT_FAILED_EXIT) {
    throw new DaemonError(
      'transfer_failed',
      `cannot create ${dirname(shown)} on target '${request.target}': ${claim.stderr.trim()}`,
      { phase: 'resolving', dir: shown },
    );
  }

  if (claim.exitCode === DIR_PRESENT_EXIT) {
    throw new DaemonError(
      'workspace_exists',
      `${shown} already exists on target '${request.target}'; a workspace is materialized only into a directory that does not exist`,
      { phase: 'resolving', dir: shown },
    );
  }

  // A directory that is not there failed for another reason, such as a
  // parent the command cannot write, which no other attempt would fix.
  if (claim.exitCode !== 0) {
    throw new DaemonError(
      'transfer_failed',
      `cannot create ${shown} on target '${request.target}': ${claim.stderr.trim()}`,
      { phase: 'resolving', dir: shown },
    );
  }

  updateProgress({ claimed: true });
}

async function recordPhase(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  updateProgress: ProgressTracker,
  phase: MaterializationPhase,
  fields: Readonly<{
    dir?: string;
    repoURL?: string;
    sha?: string;
    ref?: string | null;
    materializedAt?: number;
  }>,
): Promise<void> {
  await deps.store.updateMaterialization(
    request.sessionID,
    { phase, ...fields },
    (deps.clock ?? systemClock).now(),
  );

  updateProgress({ phase });
}

// The commit a workspace is checked out at, and the branch it is on, null
// for a detached checkout.
interface Checkout {
  readonly sha: string;
  readonly branch: string | null;
}

// Clones inside the host when it can, and uploads a clone made on the
// daemon's host otherwise.
async function createCheckout(
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

// A refusal holds the phase it failed in; one raised without a phase, such
// as a git whose output stays open, takes the phase it was raised in.
function toDaemonError(error: unknown, code: ErrorCode, phase: MaterializationPhase): DaemonError {
  if (error instanceof DaemonError) {
    return error.data?.['phase'] === undefined
      ? new DaemonError(error.code, error.message, { ...error.data, phase })
      : error;
  }

  const reason = error instanceof Error ? error.message : String(error);

  return new DaemonError(code, reason, { phase });
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

// The provider runs commands in its own environment, so the verify unsets
// every variable that could point git at another repository first.

// prints the commit HEAD resolves to and a NUL, then every tracked file whose content differs
// from HEAD, so a file the unpack left out or changed refuses the checkout whatever tar did;
// a HEAD that resolves to no commit exits at once, before the NUL
export const VERIFY_SCRIPT = String.raw`git rev-parse --verify 'HEAD^{commit}' || exit 1; printf '\0'; exec git -c core.fsmonitor=false status --porcelain --untracked-files=no`;

async function verifyTargetHead(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  landing: Landing,
  sha: string,
): Promise<void> {
  const verified = await deps.requireProvider('run').runCommand({
    argv: [...REPOSITORY_ENV_UNSET_ARGV, 'sh', '-c', VERIFY_SCRIPT],
    cwd: landing.dir,
    host: landing.host,
  });

  const split = verified.stdout.indexOf('\0');
  const actual = split === -1 ? null : verified.stdout.slice(0, split).trim();

  if (actual !== sha) {
    throw new DaemonError(
      'workspace_mismatch',
      `the checkout on target '${request.target}' is at ${actual ?? 'no commit'}, not ${sha}`,
      { phase: 'verifying', expected: sha, actual },
    );
  }

  const changed = verified.stdout
    .slice(split + 1)
    .split('\n')
    .filter((line) => line !== '');

  if (verified.exitCode !== 0 || changed.length > 0) {
    throw new DaemonError(
      'workspace_mismatch',
      `the checkout on target '${request.target}' does not match ${sha} in its tracked files: ${changed.slice(0, 5).join('; ') || verified.stderr.trim()}`,
      { phase: 'verifying', expected: sha, actual },
    );
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

function toRedacted(text: string, secret: string): string {
  return text.replaceAll(secret, '[credential]');
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
