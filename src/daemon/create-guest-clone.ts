import { DaemonError } from '../protocol/daemon-error';
import { collectCredentialConfigKeys } from '../workspace/collect-credential-config-keys';
import { REPOSITORY_ENV_VARS } from '../workspace/repository-env-vars';
import type { ExecutionProvider } from './execution-provider';

interface GuestCloneRequest {
  // The host the clone runs on, and the directory there it lands in, which
  // exists and is empty.
  readonly host: string;
  readonly dir: string;

  // The token-free URL the clone fetches from and records as its origin.
  readonly url: string;

  // The commit the checkout is pinned to, and the branch it is checked out
  // as, null for a detached checkout.
  readonly sha: string;
  readonly branch: string | null;

  // The transports git may fetch over.
  readonly transports: readonly string[];
}

// The clone could not be made in the host, and its directory is empty again,
// so the workspace can be built another way. The reason holds git's first
// line of error.
type GuestClone = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Builds a workspace checkout inside an execution host with one command run
 * there: a blobless clone of the URL, with the pinned commit checked out as
 * its branch or detached, isolated from the host's system and global git
 * config so no filter, hook, or credential helper configured there runs. The
 * host's own network fetches the repository, so no repository bytes cross
 * the daemon's link; a host whose broker holds a GitHub grant reads private
 * repositories through it.
 *
 * The checkout must be the whole workspace, as a clone on the daemon's host
 * must: one that uses submodules is refused as `has_submodules` and one that
 * tracks paths through Git LFS as `lfs_unsupported`. It is then sanitized
 * in place: the origin is set to the URL, hooks, reflogs, and any
 * `.git-credentials` or `.netrc` file are removed, and a repository config
 * that still holds a credential is refused as `sanitize_failed`.
 *
 * A clone or checkout that fails, as one of a repository the host cannot
 * read does, empties the directory and resolves to the reason, so the
 * caller can build the workspace another way. Every other failure throws a
 * refusal with its own code.
 */
export async function createGuestClone(
  provider: Pick<ExecutionProvider, 'runCommand'>,
  request: GuestCloneRequest,
): Promise<GuestClone> {
  const run = await provider.runCommand({
    argv: [
      ...GUEST_CLONE_ENV,
      'sh',
      '-c',
      GUEST_CLONE_SCRIPT,
      'sh',
      request.dir,
      request.url,
      request.sha,
      request.branch ?? '',
      request.transports.join(':'),
    ],
    cwd: '/',
    host: request.host,
  });

  const error = run.stderr.trim();

  if (run.exitCode === UNREADABLE_TREE_EXIT) {
    throw new DaemonError('unreadable_tree', `cannot read the tree of ${request.sha}: ${error}`, {
      phase: 'cloning',
    });
  }

  if (run.exitCode === SUBMODULES_EXIT) {
    throw new DaemonError('has_submodules', `${request.sha} uses submodules`, {
      phase: 'cloning',
    });
  }

  if (run.exitCode === LFS_EXIT) {
    const paths = run.stdout.split('\0').filter((path) => path !== '');

    throw new DaemonError(
      'lfs_unsupported',
      `${request.sha} tracks ${paths.length} path(s) through Git LFS`,
      { phase: 'cloning', count: paths.length, paths: paths.slice(0, LFS_PATHS_SHOWN) },
    );
  }

  if (run.exitCode === SANITIZE_EXIT) {
    throw new DaemonError('sanitize_failed', error, { phase: 'cloning' });
  }

  if (run.exitCode !== 0) {
    return { ok: false, reason: error.split('\n')[0] ?? '' };
  }

  const remaining = collectCredentialConfigKeys(run.stdout);

  if (remaining.length > 0) {
    throw new DaemonError(
      'sanitize_failed',
      `config still holds ${remaining.length} credential entries`,
      { phase: 'cloning' },
    );
  }

  return { ok: true };
}

// The host runs commands in its own environment, so the clone unsets every
// variable that could point git at another repository first.
const GUEST_CLONE_ENV = ['env', ...[...REPOSITORY_ENV_VARS].flatMap((name) => ['-u', name])];

// Exit statuses of the script for each refusal it reports; a clone or a
// checkout that fails exits with git's status once the directory is empty.
const UNREADABLE_TREE_EXIT = 81;
const SUBMODULES_EXIT = 82;
const LFS_EXIT = 83;
const SANITIZE_EXIT = 84;
const LFS_PATHS_SHOWN = 5;

// Arguments: the directory, the URL, the commit, the branch or empty for a
// detached checkout, and the transports git may fetch over, joined by `:`.
// On success it prints the repository config as `git config --list -z`
// does; on an LFS refusal, every LFS path, each ended by a NUL.
const GUEST_CLONE_SCRIPT = String.raw`dir=$1 url=$2 sha=$3 branch=$4
export GIT_CONFIG_NOSYSTEM=1 GIT_ATTR_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 LC_ALL=C GIT_ALLOW_PROTOCOL=$5
iso="-c core.attributesFile=/dev/null -c core.hooksPath=/dev/null -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false"
empty() { status=$?; find "$dir" -mindepth 1 -delete; exit "$status"; }
git clone --quiet --no-local --no-hardlinks --no-checkout --filter=blob:none --template= -- "$url" "$dir" || empty
cd "$dir" || empty
if [ -n "$branch" ]; then git $iso checkout --quiet -B "$branch" "$sha" || empty
else git $iso checkout --quiet --detach "$sha" || empty; fi
tree=$(git $iso ls-tree -r --full-tree "$sha") || exit ${UNREADABLE_TREE_EXIT}
tab=$(printf '\t')
printf '%s\n' "$tree" | grep -q -e '^160000 ' -e "$tab\.gitmodules\$" && exit ${SUBMODULES_EXIT}
git $iso ls-files -z -- ':(attr:filter=lfs)' > .git/atc-lfs || exit ${UNREADABLE_TREE_EXIT}
if [ -s .git/atc-lfs ]; then cat .git/atc-lfs; exit ${LFS_EXIT}; fi
rm -f .git/atc-lfs
git config --file .git/config remote.origin.url "$url" || exit ${SANITIZE_EXIT}
rm -rf .git/hooks .git/logs && mkdir .git/hooks || exit ${SANITIZE_EXIT}
rm -f .git-credentials .netrc .git/.git-credentials .git/.netrc || exit ${SANITIZE_EXIT}
git log -1 --format=%H > /dev/null || exit ${SANITIZE_EXIT}
exec git config --file .git/config --list -z`;
