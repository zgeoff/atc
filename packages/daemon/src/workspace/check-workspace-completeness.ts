import { runGit } from './run-git';

type CompletenessFinding =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'has_submodules' | 'unreadable_tree';
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly code: 'lfs_unsupported';
      readonly message: string;
      readonly count: number;
      readonly paths: readonly string[];
    };

const LFS_PATHS_SHOWN = 5;

export async function checkWorkspaceCompleteness(
  dir: string,
  sha: string,
): Promise<CompletenessFinding> {
  const tree = await runGit(['ls-tree', '-r', '--full-tree', sha], { cwd: dir, isolated: true });

  if (tree.exitCode !== 0) {
    return {
      ok: false,
      code: 'unreadable_tree',
      message: `cannot list the tree of ${sha}: ${tree.stderr.trim()}`,
    };
  }

  const entries = tree.stdout.split('\n');

  // submodules are never initialized, so either would leave a hole in the checkout
  if (entries.some((line) => line.startsWith('160000 ') || line.endsWith('\t.gitmodules'))) {
    return { ok: false, code: 'has_submodules', message: `${sha} uses submodules` };
  }

  const tracked = await runGit(['ls-files', '-z'], { cwd: dir, isolated: true });

  const attributes = await runGit(['check-attr', '--stdin', '-z', 'filter'], {
    cwd: dir,
    input: tracked.stdout,
    isolated: true,
  });

  if (tracked.exitCode !== 0 || attributes.exitCode !== 0) {
    return {
      ok: false,
      code: 'unreadable_tree',
      message: `cannot read the attributes of ${sha}: ${tracked.stderr.trim()}${attributes.stderr.trim()}`,
    };
  }

  const lfsPaths = collectLFSPaths(attributes.stdout);

  // an LFS path's content would be a pointer file rather than the object it points at
  if (lfsPaths.length > 0) {
    return {
      ok: false,
      code: 'lfs_unsupported',
      message: `${sha} tracks ${lfsPaths.length} path(s) through Git LFS`,
      count: lfsPaths.length,
      paths: lfsPaths.slice(0, LFS_PATHS_SHOWN),
    };
  }

  return { ok: true };
}

// `check-attr -z` writes one path, attribute, value triple per path.
function collectLFSPaths(output: string): string[] {
  const fields = output.split('\0');
  const paths: string[] = [];

  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index + 2] === 'lfs') {
      paths.push(fields[index] ?? '');
    }
  }

  return paths;
}
