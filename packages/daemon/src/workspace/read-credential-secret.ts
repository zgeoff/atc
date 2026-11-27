import type { GitCredential } from './create-git-askpass';

export function readCredentialSecret(credential: GitCredential | undefined): string | null {
  if (credential === undefined) {
    return null;
  }

  const value = process.env[credential.name];

  return value === undefined || value === '' ? null : value;
}
