export type RepoInput =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'repo'; readonly nameWithOwner: string }
  | { readonly kind: 'owner'; readonly owner: string }
  | { readonly kind: 'filter'; readonly text: string };

// A URL with a scheme, an scp-style `user@host:path`, or a path on the
// daemon's host.
const URL_PATTERN = /^(?:[a-z][a-z\d+.-]*:\/\/|[^@/:\s]+@[^@/:\s]+:|\/)/iu;
const REPO_PATTERN = /^[A-Za-z\d][\w.-]*\/[\w.-]+$/u;
const OWNER_PATTERN = /^(?<owner>[A-Za-z\d][A-Za-z\d-]*)\/$/u;

/**
 * Reads what the repository step's input holds: a git URL or a path on the
 * daemon's host, a GitHub `owner/repo`, an `owner/` whose repositories to
 * list, or text that filters the listed repositories.
 */
export function parseRepoInput(input: string): RepoInput {
  const text = input.trim();

  if (URL_PATTERN.test(text)) {
    return { kind: 'url', url: text };
  }

  const owner = OWNER_PATTERN.exec(text)?.groups?.['owner'];

  if (owner !== undefined) {
    return { kind: 'owner', owner };
  }

  if (REPO_PATTERN.test(text)) {
    return { kind: 'repo', nameWithOwner: text.replace(/\.git$/u, '') };
  }

  return { kind: 'filter', text };
}
