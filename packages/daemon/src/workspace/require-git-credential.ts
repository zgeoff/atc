import type { GitCredentialHosts } from '@atc/config';
import type { SpawnWorkspaceSource } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';
import type { GitCredential } from './create-git-askpass';
import { expandGitShorthand } from './expand-git-shorthand';
import { resolveGitCredential } from './resolve-git-credential';

// A credential is checked against the config before its variable is read or any git runs, so a
// refused name reveals nothing about the daemon's environment.
export function requireGitCredential(
  source: SpawnWorkspaceSource,
  gitCredentials: GitCredentialHosts,
): GitCredential | undefined {
  if (source.kind !== 'git') {
    return undefined;
  }

  const resolved = resolveGitCredential(
    source.credentialRef,
    expandGitShorthand(source.url),
    gitCredentials,
  );

  if (!resolved.ok) {
    throw new AtcError(resolved.code, resolved.message, { phase: 'resolving' });
  }

  return resolved.credential;
}
