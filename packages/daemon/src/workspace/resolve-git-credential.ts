import type { GitCredentialHosts } from '@atc/config';
import type { GitCredential } from './create-git-askpass';
import { normalizeGitURL } from './normalize-git-url';

interface CredentialRef {
  readonly kind: 'env';
  readonly name: string;
}

type ResolvedGitCredential =
  | { readonly ok: true; readonly credential: GitCredential | undefined }
  | { readonly ok: false; readonly code: 'bad_args'; readonly message: string };

export function resolveGitCredential(
  ref: CredentialRef | undefined,
  url: string,
  allowed: GitCredentialHosts,
): ResolvedGitCredential {
  if (ref === undefined) {
    return { ok: true, credential: undefined };
  }

  const hosts = allowed.get(ref.name);

  if (hosts === undefined) {
    return {
      ok: false,
      code: 'bad_args',
      message: `workspaces.gitCredentials in the daemon's config does not list the credentialRef ${ref.name}`,
    };
  }

  const host = findHTTPHost(url);

  if (host === null) {
    return {
      ok: false,
      code: 'bad_args',
      message: 'a credentialRef is sent only with an https or http repository URL',
    };
  }

  if (!hosts.includes(host)) {
    return {
      ok: false,
      code: 'bad_args',
      message: `workspaces.gitCredentials in the daemon's config does not allow the credentialRef ${ref.name} for ${host}`,
    };
  }

  return { ok: true, credential: { kind: 'env', name: ref.name, hosts } };
}

function findHTTPHost(url: string): string | null {
  const normalized = normalizeGitURL(url);

  if (!normalized.ok) {
    return null;
  }

  try {
    const parsed = new URL(normalized.url);

    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.host.toLowerCase()
      : null;
  } catch {
    return null;
  }
}
