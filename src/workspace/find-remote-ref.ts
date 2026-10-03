interface RemoteRefMatch {
  readonly sha: string;

  // The branch the ref names, or null for a tag.
  readonly branch: string | null;
}

/**
 * Finds the commit a ref points at among the refs an upstream lists, keyed
 * by full ref name with each annotated tag's peeled `^{}` entry beside it.
 * A bare name matches a branch before a same-named tag, a `refs/heads/` or
 * `refs/tags/` name matches only that kind, and an annotated tag resolves
 * to the commit it points at. Null when the upstream has no such branch or
 * tag.
 */
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
