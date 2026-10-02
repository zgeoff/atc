import { createHash } from 'node:crypto';
import { sortJSONKeys } from '../shared/sort-json-keys';

/**
 * The identity a session binds to when it spawns on a target: the provider
 * kind, a colon, and the first 16 hex digits of a sha256 over the target's
 * options with sorted keys. A target name reused with another provider or
 * other options has another identity. Target options hold no credential
 * values, only references such as an environment variable's name, so the
 * identity never derives from a secret.
 */
export function buildTargetIdentity(
  kind: string,
  options: Readonly<Record<string, unknown>>,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(sortJSONKeys(options)))
    .digest('hex')
    .slice(0, 16);

  return `${kind}:${digest}`;
}
