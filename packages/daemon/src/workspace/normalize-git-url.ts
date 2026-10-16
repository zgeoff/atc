type NormalizedGitURL =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly code: 'invalid_git_url'; readonly message: string };

const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//iu;
const SCP_PATTERN = /^(?:[^@/:\s]+@)?[^@/:\s]+:[^@\s]+$/u;

/**
 * Reduces a repository URL to a form that carries no credential, so it can be
 * recorded, shown, and handed to another host. An http(s) URL loses its
 * userinfo, query, and fragment, where tokens ride. Any other scheme URL
 * loses its password but keeps its user, which is a login name such as
 * `git`. An scp-style `git@host:owner/repo` and a local path pass through.
 * Anything else, a bare `owner/repo` included, is refused.
 */
export function normalizeGitURL(raw: string): NormalizedGitURL {
  const trimmed = raw.trim();

  if (SCHEME_PATTERN.test(trimmed)) {
    return normalizeSchemeURL(trimmed);
  }

  if (trimmed.startsWith('/')) {
    return { ok: true, url: trimmed };
  }

  if (SCP_PATTERN.test(trimmed)) {
    return { ok: true, url: trimmed };
  }

  return { ok: false, code: 'invalid_git_url', message: 'not a git repository URL' };
}

const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

function normalizeSchemeURL(raw: string): NormalizedGitURL {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'invalid_git_url', message: 'not a parseable repository URL' };
  }

  url.password = '';

  if (HTTP_PROTOCOLS.has(url.protocol)) {
    url.username = '';
    url.search = '';
    url.hash = '';
  }

  return { ok: true, url: url.toString() };
}
