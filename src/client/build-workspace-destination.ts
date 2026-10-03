interface DestinationParts {
  // The root the checkout lands under, absolute on its target.
  readonly root: string;

  // The repository URL the checkout comes from, as the daemon resolved it.
  readonly url: string;

  // The branch or tag the commit was chosen by, or null for a bare commit.
  readonly ref: string | null;
  readonly sha: string;
}

/**
 * The default directory a git workspace lands in: `<repo>-<ref>-<short
 * sha>` under the root, with the ref left out for a bare commit. The repo
 * is the URL's last path segment without `.git`, and each part keeps only
 * `[A-Za-z0-9._-]`, with `/` turned into `-`, so the name is one path
 * segment on any target.
 */
export function buildWorkspaceDestination(parts: DestinationParts): string {
  const repo =
    parts.url
      .replace(/\/+$/u, '')
      .split(/[/:]/u)
      .at(-1)
      ?.replace(/\.git$/u, '') ?? '';

  const name = [repo, ...(parts.ref === null ? [] : [parts.ref]), parts.sha.slice(0, 7)]
    .map((part) => toSafeSegment(part))
    .filter((part) => part !== '')
    .join('-');

  return `${parts.root.replace(/\/+$/u, '')}/${name}`;
}

function toSafeSegment(part: string): string {
  return part.replaceAll('/', '-').replaceAll(/[^\w.-]/gu, '');
}
