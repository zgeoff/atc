import type { ExecutionProvider } from '@atc/plugin-api';
import { AtcError } from '@atcx/contract/light';
import { collectCredentialConfigKeys } from './collect-credential-config-keys';
import { REPOSITORY_ENV_UNSET_ARGV } from './repository-env-unset-argv';

interface GuestCloneRequest {
  readonly host: string;
  readonly directory: string;

  readonly url: string;

  readonly sha: string;
  readonly branch: string | null;

  readonly transports: readonly string[];
}

type GuestClone = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const LFS_PATHS_SHOWN = 5;
const UNREADABLE_TREE_EXIT = 81;
const SUBMODULES_EXIT = 82;
const LFS_EXIT = 83;
const SANITIZE_EXIT = 84;

export const GUEST_CLONE_SCRIPT = String.raw`dir=$1 url=$2 sha=$3 branch=$4
export GIT_CONFIG_NOSYSTEM=1 GIT_ATTR_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 LC_ALL=C GIT_ALLOW_PROTOCOL="$5"
iso() { git -c core.attributesFile=/dev/null -c core.hooksPath=/dev/null -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false "$@"; }
empty() { status=$?; find "$dir" -mindepth 1 -delete; exit "$status"; }
git clone --quiet --no-local --no-hardlinks --no-checkout --filter=blob:none --template= -- "$url" "$dir" || empty
cd "$dir" || empty
if [ -n "$branch" ]; then iso checkout --quiet -B "$branch" "$sha" || empty
else iso checkout --quiet --detach "$sha" || empty; fi
tree=$(iso ls-tree -r --full-tree "$sha") || exit ${UNREADABLE_TREE_EXIT}
tab=$(printf '\t')
printf '%s\n' "$tree" | grep -q -e '^160000 ' -e "$tab\.gitmodules\$" && exit ${SUBMODULES_EXIT}
iso ls-files -z -- ':(attr:filter=lfs)' > .git/atc-lfs || exit ${UNREADABLE_TREE_EXIT}
if [ -s .git/atc-lfs ]; then cat .git/atc-lfs; exit ${LFS_EXIT}; fi
rm -f .git/atc-lfs
git config --file .git/config remote.origin.url "$url" || exit ${SANITIZE_EXIT}
rm -rf .git/hooks .git/logs && mkdir .git/hooks || exit ${SANITIZE_EXIT}
rm -f .git-credentials .netrc .git/.git-credentials .git/.netrc || exit ${SANITIZE_EXIT}
git log -1 --format=%H > /dev/null || exit ${SANITIZE_EXIT}
exec git config --file .git/config --list -z`;

// The clone runs on the host, not in the daemon, so repository bytes never cross the daemon's link.
export async function createGuestClone(
  provider: Pick<ExecutionProvider, 'runCommand'>,
  request: GuestCloneRequest,
): Promise<GuestClone> {
  const run = await provider.runCommand({
    argv: [
      ...REPOSITORY_ENV_UNSET_ARGV,
      'sh',
      '-c',
      GUEST_CLONE_SCRIPT,
      'sh',
      request.directory,
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
    throw new AtcError('unreadable_tree', `cannot read the tree of ${request.sha}: ${error}`, {
      phase: 'cloning',
    });
  }

  if (run.exitCode === SUBMODULES_EXIT) {
    throw new AtcError('has_submodules', `${request.sha} uses submodules`, {
      phase: 'cloning',
    });
  }

  if (run.exitCode === LFS_EXIT) {
    const paths = run.stdout.split('\0').filter((path) => path !== '');

    throw new AtcError(
      'lfs_unsupported',
      `${request.sha} tracks ${paths.length} path(s) through Git LFS`,
      { phase: 'cloning', count: paths.length, paths: paths.slice(0, LFS_PATHS_SHOWN) },
    );
  }

  if (run.exitCode === SANITIZE_EXIT) {
    throw new AtcError('sanitize_failed', error, { phase: 'cloning' });
  }

  if (run.exitCode !== 0) {
    return { ok: false, reason: error.split('\n')[0] ?? '' };
  }

  const remaining = collectCredentialConfigKeys(run.stdout);

  if (remaining.length > 0) {
    throw new AtcError(
      'sanitize_failed',
      `config still holds ${remaining.length} credential entries`,
      { phase: 'cloning' },
    );
  }

  return { ok: true };
}

// The host runs commands in its own environment, which can carry git variables such as GIT_DIR
// that point git at a different repository.
