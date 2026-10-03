import { checkGitTransport } from './check-git-transport';
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
 * Resolves the URL a git workspace source is fetched from: it normalizes
 * to its credential-free form, and that form must use one of `transports`, both checked
 * before any git runs. Then the raw URL and the normalized form must each
 * reach git without a credential. `cwd` is the directory whose git config
 * the `insteadOf` rewrites are read from.
 */
export async function resolveGitURL(
  raw: string,
  cwd: string,
  transports: readonly string[],
): Promise<ResolvedGitURL> {
  const normalized = normalizeGitURL(raw);

  if (!normalized.ok) {
    return normalized;
  }

  const transport = checkGitTransport(normalized.url, transports);

  if (!transport.ok) {
    return transport;
  }

  const plain = await checkURLCredentials(raw, cwd);

  if (!plain.ok) {
    return plain;
  }

  const expanded = await checkURLCredentials(normalized.url, cwd);

  return expanded.ok ? normalized : expanded;
}
