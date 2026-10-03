import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DaemonError } from '../protocol/daemon-error';
import type { ErrorCode } from '../protocol/protocol';
import type { SpawnWorkspaceSource } from '../protocol/request-param-schemas';
import type { SessionID } from '../shared/session-id';
import type { StateStore } from '../store/state-store';
import type { MaterializationPhase, SessionWorkspace } from '../store/workspace-materialization';
import { checkURLCredentials } from '../workspace/check-url-credentials';
import { createWorkspaceClone } from '../workspace/create-workspace-clone';
import { normalizeGitURL } from '../workspace/normalize-git-url';
import { readWorkspaceTar } from '../workspace/read-workspace-tar';
import { REPOSITORY_ENV_VARS } from '../workspace/repository-env-vars';
import { resolvePathSource } from '../workspace/resolve-path-source';
import { runGit } from '../workspace/run-git';
import { sanitizeWorkspaceClone } from '../workspace/sanitize-workspace-clone';
import type { ExecutionProvider } from './execution-provider';

interface MaterializeRequest {
  readonly sessionID: SessionID;
  readonly target: string;

  // The directory on the target the workspace lands in; it must not exist.
  readonly dir: string;
  readonly source: SpawnWorkspaceSource;

  // Whether the target is the daemon's own host, where a directory outside
  // any git work tree runs in place instead of being materialized.
  readonly inPlace: boolean;
}

interface MaterializeDeps {
  // The target's provider for one operation, after the execution gate
  // passes it; throws the gate's refusal otherwise.
  readonly requireProvider: (capability: 'run' | 'transfer') => ExecutionProvider;
  readonly store: Pick<StateStore, 'createMaterialization' | 'updateMaterialization'>;
  readonly log: (line: string) => void;
}

type MaterializedWorkspace = { readonly kind: 'in_place' } | ReadyWorkspace;

interface ReadyWorkspace {
  readonly kind: 'ready';
  readonly workspace: SessionWorkspace;
  readonly warnings: readonly string[];

  // The variables every harness the session starts goes without.
  readonly withheldEnv: readonly string[];
}

interface MaterializationProgress {
  phase: MaterializationPhase;

  // Whether this call created the target directory, so a failure removes
  // only a directory it made.
  claimed: boolean;
}

// Moves a materialization's progress along as each step completes.
type ProgressTracker = (update: Readonly<Partial<MaterializationProgress>>) => void;

/**
 * Builds a spawn's working directory on its execution target as a clean
 * checkout of a pushed commit, through the target provider's generic
 * operations alone. The source resolves to a repository URL and a commit,
 * the target directory is claimed with a `mkdir` that fails if it exists,
 * the daemon clones and sanitizes the commit on its own host and tars it,
 * the provider unpacks the archive into the directory, and a `git
 * rev-parse HEAD` the provider runs there must print the pinned commit.
 * Each provider call passes the execution gate first.
 *
 * Every phase is recorded before it starts, so a daemon that stops partway
 * leaves a row the next start fails as interrupted. A refusal fails the
 * row, removes a directory this call claimed, and throws a `DaemonError`
 * whose message and data never hold the credential.
 *
 * A path source on the daemon's own host that lies outside any git work
 * tree is not materialized: the session runs in it as it stands, and the
 * spawn's directory must be that path.
 */
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

  const staging = await mkdtemp(join(tmpdir(), 'atc-workspace-'));

  const progress: MaterializationProgress = { phase: 'resolving', claimed: false };

  const updateProgress = (update: Readonly<Partial<MaterializationProgress>>) => {
    Object.assign(progress, update);
  };

  await deps.store.createMaterialization(
    {
      sessionID: request.sessionID,
      target: request.target,
      dir: request.dir,
      sourceKind: source.kind,
      withheldEnv,
    },
    Date.now(),
  );

  try {
    const ready = await runMaterialization(request, deps, staging, updateProgress, secret);

    return { ...ready, withheldEnv };
  } catch (error) {
    const refusal = toScrubbedRefusal(error, progress.phase, secret);

    await tryRemoveClaimedDir(request, deps, progress, secret);
    await tryUpdateFailed(request, deps, refusal.code);

    deps.log(
      `atc: workspace for session ${request.sessionID} failed while ${progress.phase}: ${refusal.code}: ${refusal.message}`,
    );

    throw refusal;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// The variables only the clone's git commands may see: a git source's
// credential variable, and the askpass helper and secret variables the clone
// hands its network commands. A harness inherits the daemon's environment,
// so the session withholds these from every harness it starts.
const ASKPASS_ENV = ['GIT_ASKPASS', 'ATC_GIT_ASKPASS_SECRET'];

function buildWithheldEnv(source: SpawnWorkspaceSource): string[] {
  return source.kind === 'git' && source.credentialRef !== undefined
    ? [source.credentialRef.name, ...ASKPASS_ENV]
    : [...ASKPASS_ENV];
}

// Whether a path is a directory that no git work tree holds. Only git's own
// answer that no repository holds it proves that: any other failure to
// inspect the path, such as a broken config or a repository git does not
// trust, refuses the spawn rather than run it in place unchecked.
async function isOutsideWorkTree(path: string): Promise<boolean> {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: path }).catch(
    () => null,
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
  const pinned = await resolveSource(request.source, staging);

  // What is recorded and returned is scrubbed of the credential, even
  // where a caller's own ref happens to spell it.
  const repoURL = secret === null ? pinned.repoURL : toRedacted(pinned.repoURL, secret);
  const ref = secret === null || pinned.ref === null ? pinned.ref : toRedacted(pinned.ref, secret);

  await claimTargetDir(request, deps, updateProgress);
  await recordPhase(request, deps, updateProgress, 'cloning', { repoURL, ref });

  const clone = await createCleanClone(pinned, join(staging, 'clone'));

  // The archive is in memory, so the clone leaves the daemon's host before
  // the target is touched.
  await rm(staging, { recursive: true, force: true });
  await recordPhase(request, deps, updateProgress, 'transferring', { sha: clone.sha });

  try {
    await deps.requireProvider('transfer').transferArchive(clone.archive, request.dir);
  } catch (error) {
    throw toDaemonError(error, 'transfer_failed', 'transferring');
  }

  await recordPhase(request, deps, updateProgress, 'verifying', {});
  await verifyTargetHead(request, deps, clone.sha);

  const materializedAt = Date.now();

  await recordPhase(request, deps, updateProgress, 'ready', { materializedAt });

  return {
    kind: 'ready',
    workspace: {
      repoURL,
      sha: clone.sha,
      ...(ref === null ? {} : { ref }),
      materializedAt,
    },
    warnings: pinned.warnings,
  };
}

interface PinnedSource {
  // The URL the clone fetches from and the token-free form it is recorded
  // under.
  readonly cloneURL: string;
  readonly repoURL: string;

  // The ref or commit the clone checks out, and the branch or tag recorded.
  readonly checkout: string;
  readonly ref: string | null;
  readonly credential: { readonly kind: 'env'; readonly name: string } | undefined;
  readonly warnings: readonly string[];
}

/**
 * Turns a source into what the clone needs, refusing a source that is
 * not a pushed, complete, credential-free repository. A path source pins
 * its pushed HEAD; a git source keeps its ref, which the clone pins.
 */
async function resolveSource(source: SpawnWorkspaceSource, staging: string): Promise<PinnedSource> {
  if (source.kind === 'path') {
    // The origin is checked as configured, before resolving it applies any
    // rewrite: a rewrite the checkout's own config holds expands it too.
    await requireNoOriginRewriteCredentials(source.path);

    const resolved = await resolvePathSource(source.path, {
      allowDirty: source.allowDirty ?? 'refuse',
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

  await requireNoURLCredentials(source.url, staging);

  // The clone fetches the URL it records, so an `owner/repo` shorthand
  // reaches the repository it expands to.
  const normalized = normalizeGitURL(source.url);

  if (!normalized.ok) {
    throw new DaemonError(normalized.code, normalized.message, { phase: 'resolving' });
  }

  await requireNoURLCredentials(normalized.url, staging);

  return {
    cloneURL: normalized.url,
    repoURL: normalized.url,
    checkout: source.sha ?? source.ref ?? '',
    ref: source.ref ?? null,
    credential: source.credentialRef,
    warnings: [],
  };
}

/**
 * Refuses a checkout whose configured origin a rewrite expands into a URL
 * with a credential. A credential the origin itself holds is stripped when
 * the source resolves, so only the rewrite is checked here. A checkout with
 * no readable origin is left to resolution to refuse.
 */
async function requireNoOriginRewriteCredentials(path: string): Promise<void> {
  const origin = await runGit(['config', '--get', 'remote.origin.url'], { cwd: path }).catch(
    () => null,
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

/**
 * Creates the target directory as the claim on it: `mkdir` without `-p`
 * fails when the directory exists, so a materialization never unpacks over
 * files it did not put there. The parent is created first.
 */
async function claimTargetDir(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  updateProgress: ProgressTracker,
): Promise<void> {
  const parent = await deps
    .requireProvider('run')
    .runCommand({ argv: ['mkdir', '-p', '--', dirname(request.dir)], cwd: '/' });

  if (parent.exitCode !== 0) {
    throw new DaemonError(
      'transfer_failed',
      `cannot create ${dirname(request.dir)} on target '${request.target}': ${parent.stderr.trim()}`,
      { phase: 'resolving', dir: request.dir },
    );
  }

  const claim = await deps
    .requireProvider('run')
    .runCommand({ argv: ['mkdir', '--', request.dir], cwd: '/' });

  if (claim.exitCode !== 0) {
    throw new DaemonError(
      'workspace_exists',
      `${request.dir} already exists on target '${request.target}'; a workspace is materialized only into a directory that does not exist`,
      { phase: 'resolving', dir: request.dir },
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
    repoURL?: string;
    sha?: string;
    ref?: string | null;
    materializedAt?: number;
  }>,
): Promise<void> {
  await deps.store.updateMaterialization(request.sessionID, { phase, ...fields }, Date.now());

  updateProgress({ phase });
}

interface CleanClone {
  readonly sha: string;
  readonly archive: Uint8Array;
}

/**
 * Clones the pinned source into a staging directory on the daemon's host,
 * sanitizes it, and reads it back as a tar archive.
 */
async function createCleanClone(pinned: PinnedSource, dir: string): Promise<CleanClone> {
  const clone = await createWorkspaceClone({
    source: { kind: 'git', url: pinned.cloneURL, ref: pinned.checkout },
    dir,
    ...(pinned.credential === undefined ? {} : { credential: pinned.credential }),
  });

  if (!clone.ok) {
    const { ok: _ok, code, message, ...detail } = clone;

    throw new DaemonError(code, message, { phase: 'cloning', ...detail });
  }

  const sanitized = await sanitizeWorkspaceClone(dir, pinned.cloneURL);

  if (!sanitized.ok) {
    throw new DaemonError(sanitized.code, sanitized.message, { phase: 'cloning' });
  }

  const tar = readWorkspaceTar(dir);

  const bytes = await new Response(tar.stream).arrayBuffer();

  const archive = new Uint8Array(bytes);

  const outcome = await tar.done;

  if (!outcome.ok) {
    throw new DaemonError(outcome.code, outcome.message, { phase: 'cloning' });
  }

  return { sha: clone.sha, archive };
}

function toDaemonError(error: unknown, code: ErrorCode, phase: MaterializationPhase): DaemonError {
  if (error instanceof DaemonError) {
    return error;
  }

  const reason = error instanceof Error ? error.message : String(error);

  return new DaemonError(code, reason, { phase });
}

// The provider runs commands in its own environment, so the verify unsets
// every variable that could point git at another repository first.
const VERIFY_ENV = ['env', ...[...REPOSITORY_ENV_VARS].flatMap((name) => ['-u', name])];
const VERIFY_ARGV = ['git', 'rev-parse', '--verify', 'HEAD^{commit}'];

// Lists every tracked file whose content differs from HEAD, so a file the
// unpack left out or changed refuses the checkout whatever tar did there.
const STATUS_ARGV = [
  'git',
  '-c',
  'core.fsmonitor=false',
  'status',
  '--porcelain',
  '--untracked-files=no',
];

async function verifyTargetHead(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  sha: string,
): Promise<void> {
  const head = await deps
    .requireProvider('run')
    .runCommand({ argv: [...VERIFY_ENV, ...VERIFY_ARGV], cwd: request.dir });

  const actual = head.exitCode === 0 ? head.stdout.trim() : null;

  if (actual !== sha) {
    throw new DaemonError(
      'workspace_mismatch',
      `the checkout on target '${request.target}' is at ${actual ?? 'no commit'}, not ${sha}`,
      { phase: 'verifying', expected: sha, actual },
    );
  }

  const status = await deps
    .requireProvider('run')
    .runCommand({ argv: [...VERIFY_ENV, ...STATUS_ARGV], cwd: request.dir });

  const changed = status.stdout.split('\n').filter((line) => line !== '');

  if (status.exitCode !== 0 || changed.length > 0) {
    throw new DaemonError(
      'workspace_mismatch',
      `the checkout on target '${request.target}' does not match ${sha} in its tracked files: ${changed.slice(0, 5).join('; ') || status.stderr.trim()}`,
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

/**
 * Removes the target directory after a failure, when this call created it,
 * so a failed materialization leaves no partial checkout behind. A removal
 * that fails is logged; the directory then stays and blocks the next
 * materialization into it with `workspace_exists`.
 */
async function tryRemoveClaimedDir(
  request: MaterializeRequest,
  deps: MaterializeDeps,
  progress: Readonly<MaterializationProgress>,
  secret: string | null,
): Promise<void> {
  if (!progress.claimed) {
    return;
  }

  try {
    const removed = await deps
      .requireProvider('run')
      .runCommand({ argv: ['rm', '-rf', '--', request.dir], cwd: '/' });

    if (removed.exitCode !== 0) {
      throw new Error(removed.stderr.trim());
    }
  } catch (error) {
    const reason = toScrubbedRefusal(error, progress.phase, secret).message;

    deps.log(
      `atc: cannot remove ${request.dir} after its workspace for session ${request.sessionID} failed: ${reason}`,
    );
  }
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
      Date.now(),
    );
  } catch {
    // A row left short of failed is failed as interrupted at the next start.
  }
}
