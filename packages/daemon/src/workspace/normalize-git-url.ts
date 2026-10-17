type NormalizedGitURL =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly code: 'invalid_git_url'; readonly message: string };

const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//iu;
const SCP_PATTERN = /^(?:[^@/:\s]+@)?[^@/:\s]+:[^@\s]+$/u;

// the credential-free form, which is safe to record, show, and hand to another host
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

  // any other scheme keeps its user, which is a login name such as `git`
  if (HTTP_PROTOCOLS.has(url.protocol)) {
    url.username = '';
    url.search = '';
    url.hash = '';
  }

  return { ok: true, url: url.toString() };
}
