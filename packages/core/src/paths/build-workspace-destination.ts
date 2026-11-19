interface DestinationParts {
  // The root the checkout lands under: absolute on its target, or relative
  // to the target user's home, where an empty root is the home itself.
  readonly root: string;

  // Holds the URL as the daemon resolved it, not as the caller first wrote it.
  readonly url: string;

  readonly ref: string | null;

  // The commit checked out, or null when only the ref picks it.
  readonly sha: string | null;
}

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
