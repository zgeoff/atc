import { runGit } from './run-git';

type URLCredentialFinding =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'credential_in_url'; readonly message: string };

/**
 * Checks that a repository URL reaches git without a credential in it, so
 * a token can never surface in git's own messages or in the clone. The URL
 * itself must carry none, and no `url.<base>.insteadOf` rewrite in the git
 * config read from `cwd` may expand it into one that does. git expands the
 * URL without touching the network. An http(s) URL carries a credential in
 * its userinfo, query, or fragment; any other scheme URL only in a
 * password, since its user is a login name such as `git`.
 */
export async function checkURLCredentials(url: string, cwd: string): Promise<URLCredentialFinding> {
  // git prints the URL as it would fetch it, with every rewrite applied.
  const expanded = await runGit(['ls-remote', '--get-url', url], { cwd });

  const fetched = expanded.exitCode === 0 ? expanded.stdout.trim() : url;

  if (!hasURLCredential(fetched)) {
    return { ok: true };
  }

  return {
    ok: false,
    code: 'credential_in_url',
    message: hasURLCredential(url)
      ? 'the repository URL carries a credential; pass it as a credentialRef instead'
      : 'a url.<base>.insteadOf rewrite in the host git config puts a credential into the repository URL; remove the rewrite or pass the credential as a credentialRef',
  };
}

const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//iu;

const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

function hasURLCredential(url: string): boolean {
  if (!SCHEME_PATTERN.test(url)) {
    return false;
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (HTTP_PROTOCOLS.has(parsed.protocol)) {
    return (
      parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== ''
    );
  }

  return parsed.password !== '';
}
