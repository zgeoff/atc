import { createHash } from 'node:crypto';
import { sortJSONKeys } from '../shared/sort-json-keys';

/**
 * The identity a session binds to when it spawns on a target: the provider
 * kind, a colon, and the first 16 hex digits of a sha256 over the target's
 * options with sorted keys. Imp identities include a format version and
 * omit image, memory, and guest-atc options, which do not select an existing
 * imp. A target reused with other connection options has another identity.
 * Target options hold no credential
 * values, only references such as an environment variable's name, so the
 * identity never derives from a secret.
 */
export function buildTargetIdentity(
  kind: string,
  options: Readonly<Record<string, unknown>>,
): string {
  const boundOptions =
    kind === 'imp'
      ? Object.fromEntries(
          Object.entries(options).filter(
            ([key]) => key !== 'image' && key !== 'memoryMib' && key !== 'guestATC',
          ),
        )
      : options;

  const digest = createHash('sha256')
    .update(JSON.stringify(sortJSONKeys(boundOptions)))
    .digest('hex')
    .slice(0, 16);

  return kind === 'imp' ? `imp:reach-v1:${digest}` : `${kind}:${digest}`;
}
