import { checkURLCredentials } from './check-url-credentials';
import { normalizeGitURL } from './normalize-git-url';

type ResolvedGitURL =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly code: 'credential_in_url' | 'invalid_git_url';
      readonly message: string;
    };

/**
 * Resolves the URL a git workspace source is fetched from: the raw URL
 * must reach git without a credential, it normalizes to its credential-free
 * form, with `owner/repo` expanding to its GitHub https URL, and that form
 * must reach git without a credential too. `cwd` is the directory whose git
 * config the `insteadOf` rewrites are read from.
 */
export async function resolveGitURL(raw: string, cwd: string): Promise<ResolvedGitURL> {
  const plain = await checkURLCredentials(raw, cwd);

  if (!plain.ok) {
    return plain;
  }

  const normalized = normalizeGitURL(raw);

  if (!normalized.ok) {
    return normalized;
  }

  const expanded = await checkURLCredentials(normalized.url, cwd);

  return expanded.ok ? normalized : expanded;
}
