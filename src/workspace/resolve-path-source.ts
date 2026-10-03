import { statSync } from 'node:fs';
import { normalizeGitURL } from './normalize-git-url';
import { runGit } from './run-git';

interface PathSourceOptions {
  readonly allowDirty?: 'refuse' | 'warn';
}

interface ResolvedPathSource {
  readonly ok: true;
  readonly url: string;
  readonly sha: string;
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly warnings: readonly string[];
}

type PathSourceRefusalCode =
  | 'not_a_git_repo'
  | 'no_commits'
  | 'unreadable_tree'
  | 'has_submodules'
  | 'workspace_dirty'
  | 'no_origin'
  | 'invalid_git_url'
  | 'unpushed_head';

interface PathSourceRefusal {
  readonly ok: false;
  readonly code: PathSourceRefusalCode;
  readonly message: string;
}

/**
 * Turns a local checkout into the repository URL and commit another host
 * can clone, so a workspace never carries files that exist only here. The
 * commit is HEAD, and it must already be on origin: a remote-tracking ref
 * under origin contains it, or origin advertises it as a ref tip. A tree
 * with uncommitted or untracked changes is refused, or with `allowDirty:
 * 'warn'` resolves to HEAD and leaves those changes behind with a warning.
 * Submodules are refused. The URL is origin's, with any credential stripped.
 */
export async function resolvePathSource(
  path: string,
  options: PathSourceOptions = {},
): Promise<PathSourceRefusal | ResolvedPathSource> {
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) {
    return { ok: false, code: 'not_a_git_repo', message: `${path} is not a directory` };
  }

  const toplevel = await runGit(['rev-parse', '--show-toplevel'], { cwd: path });

  if (toplevel.exitCode !== 0) {
    return { ok: false, code: 'not_a_git_repo', message: `${path} is not inside a git work tree` };
  }

  const root = toplevel.stdout.trim();

  const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: root });

  if (head.exitCode !== 0) {
    return { ok: false, code: 'no_commits', message: `${root} has no commit to check out` };
  }

  const sha = head.stdout.trim();

  const tree = await runGit(['ls-tree', '-r', '--full-tree', sha], { cwd: root });

  if (tree.exitCode !== 0) {
    return {
      ok: false,
      code: 'unreadable_tree',
      message: `cannot list the tree of ${sha} in ${root}: ${tree.stderr.trim()}`,
    };
  }

  if (hasSubmodules(tree.stdout)) {
    return { ok: false, code: 'has_submodules', message: `${root} uses submodules` };
  }

  const status = await runGit(['status', '--porcelain', '--untracked-files=normal'], { cwd: root });

  if (status.exitCode !== 0) {
    return {
      ok: false,
      code: 'unreadable_tree',
      message: `cannot read the status of ${root}: ${status.stderr.trim()}`,
    };
  }

  const dirty = status.stdout.trim() !== '';
  const warnings: string[] = [];

  if (dirty && options.allowDirty !== 'warn') {
    return {
      ok: false,
      code: 'workspace_dirty',
      message: `${root} has uncommitted or untracked changes`,
    };
  }

  if (dirty) {
    warnings.push(`uncommitted and untracked changes in ${root} stay behind; using ${sha}`);
  }

  const origin = await runGit(['ls-remote', '--get-url', 'origin'], { cwd: root });

  const originURL = origin.stdout.trim();

  // With no origin configured, git echoes the remote name back.
  if (origin.exitCode !== 0 || originURL === '' || originURL === 'origin') {
    return { ok: false, code: 'no_origin', message: `${root} has no origin remote` };
  }

  const url = normalizeGitURL(originURL);

  if (!url.ok) {
    return { ok: false, code: url.code, message: `origin of ${root}: ${url.message}` };
  }

  const pushed = await isOnOrigin(root, sha);

  if (!pushed) {
    return { ok: false, code: 'unpushed_head', message: `${sha} is not on origin; push it first` };
  }

  const branch = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root });

  return {
    ok: true,
    url: url.url,
    sha,
    branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
    dirty,
    warnings,
  };
}

/**
 * Whether a recursive tree listing holds a gitlink or a `.gitmodules` file at
 * its root. A workspace clone never initializes submodules, so either would
 * ship an incomplete tree.
 */
function hasSubmodules(listing: string): boolean {
  return listing
    .split('\n')
    .some((line) => line.startsWith('160000 ') || line.endsWith('\t.gitmodules'));
}

/**
 * Whether origin already has the commit. A local remote-tracking ref proves
 * it without network access; failing that, origin's advertised ref tips are
 * checked, which catches a push whose tracking ref was never fetched.
 */
async function isOnOrigin(root: string, sha: string): Promise<boolean> {
  const tracking = await runGit(['branch', '-r', '--contains', sha, '--list', 'origin/*'], {
    cwd: root,
  });

  if (tracking.exitCode === 0 && tracking.stdout.trim() !== '') {
    return true;
  }

  const advertised = await runGit(['ls-remote', 'origin'], { cwd: root });

  return (
    advertised.exitCode === 0 &&
    advertised.stdout.split('\n').some((line) => line.split('\t')[0] === sha)
  );
}
