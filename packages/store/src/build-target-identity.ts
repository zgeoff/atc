import { createHash } from 'node:crypto';
import { sortJSONKeys } from '@atc/core';

// Target options hold only references to credentials, such as a variable's
// name, so the identity never derives from a secret.
export function buildTargetIdentity(
  kind: string,
  options: Readonly<Record<string, unknown>>,
): string {
  // Options that never select an existing imp stay out of its identity.
  const boundOptions =
    kind === 'imp'
      ? Object.fromEntries(
          Object.entries(options).filter(
            ([key]) =>
              key !== 'image' &&
              key !== 'memoryMib' &&
              key !== 'guestATC' &&
              key !== 'rebindChangedAuth',
          ),
        )
      : options;

  const digest = createHash('sha256')
    .update(JSON.stringify(sortJSONKeys(boundOptions, 'locale')))
    .digest('hex')
    .slice(0, 16);

  return kind === 'imp' ? `imp:reach-v1:${digest}` : `${kind}:${digest}`;
}
