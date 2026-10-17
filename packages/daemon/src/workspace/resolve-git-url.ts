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

  // the form and transport checks above run no git, so a refused URL never reaches git
  const plain = await checkURLCredentials(raw, cwd);

  if (!plain.ok) {
    return plain;
  }

  const expanded = await checkURLCredentials(normalized.url, cwd);

  return expanded.ok ? normalized : expanded;
}
