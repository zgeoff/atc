interface RemoteRefMatch {
  readonly sha: string;

  // The branch the ref names, or null for a tag.
  readonly branch: string | null;
}

export function findRemoteRef(
  refs: ReadonlyMap<string, string>,
  ref: string,
): RemoteRefMatch | null {
  const name = ref.replace(/^refs\/(?:heads|tags)\//u, '');
  const branchSHA = refs.get(`refs/heads/${name}`);

  if (branchSHA !== undefined && !ref.startsWith('refs/tags/')) {
    return { sha: branchSHA, branch: name };
  }

  const tagSHA = refs.get(`refs/tags/${name}^{}`) ?? refs.get(`refs/tags/${name}`);

  if (tagSHA !== undefined && !ref.startsWith('refs/heads/')) {
    return { sha: tagSHA, branch: null };
  }

  return null;
}
