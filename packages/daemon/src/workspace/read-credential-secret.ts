import type { SpawnWorkspaceSource } from '@atcx/contract';

export function readCredentialSecret(source: SpawnWorkspaceSource): string | null {
  if (source.kind !== 'git' || source.credentialRef === undefined) {
    return null;
  }

  const value = process.env[source.credentialRef.name];

  return value === undefined || value === '' ? null : value;
}
