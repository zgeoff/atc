import type { SpawnWorkspaceSource } from '@atcx/contract';

// The credential's value, which every message leaving this module is
// scrubbed of; null for a source without one.
export function readCredentialSecret(source: SpawnWorkspaceSource): string | null {
  if (source.kind !== 'git' || source.credentialRef === undefined) {
    return null;
  }

  const value = process.env[source.credentialRef.name];

  return value === undefined || value === '' ? null : value;
}
