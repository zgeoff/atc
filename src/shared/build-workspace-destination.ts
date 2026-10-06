interface DestinationParts {
  // The root the checkout lands under: absolute on its target, or relative
  // to the target user's home, where an empty root is the home itself.
  readonly root: string;

  // The repository URL the checkout comes from, as the daemon resolved it.
  readonly url: string;

  // The branch or tag the commit was chosen by, or null for a bare commit.
  readonly ref: string | null;

  // The commit checked out, or null when only the ref picks it.
  readonly sha: string | null;
}

/**
 * The default directory a git workspace lands in: `<repo>-<ref>-<short
 * sha>` under the root, with the ref left out for a bare commit and the
 * short sha for a ref alone. The repo is the URL's last path segment
 * without `.git`, and each part keeps only `[A-Za-z0-9._-]`, with `/`
 * turned into `-`, so the name is one path segment on any target; a name
 * with nothing left is `workspace`.
 */
export function buildWorkspaceDestination(parts: DestinationParts): string {
  const repo =
    parts.url
      .replace(/\/+$/u, '')
      .split(/[/:]/u)
      .at(-1)
      ?.replace(/\.git$/u, '') ?? '';

  const name = [
    repo,
    ...(parts.ref === null ? [] : [parts.ref]),
    ...(parts.sha === null ? [] : [parts.sha.slice(0, 7)]),
  ]
    .map((part) => toSafeSegment(part))
    .filter((part) => part !== '')
    .join('-');

  const segment = name === '' ? 'workspace' : name;
  const root = parts.root.replace(/\/+$/u, '');

  return parts.root === '' ? segment : `${root}/${segment}`;
}

function toSafeSegment(part: string): string {
  return part.replaceAll('/', '-').replaceAll(/[^\w.-]/gu, '');
}
