import { createHash } from 'node:crypto';
import type { TargetIdentityRule } from '@atc/core';
import { sortJSONKeys } from '@atc/core';

// Target options hold only references to credentials, such as a variable's
// name, so the identity never derives from a secret.
export function buildTargetIdentity(
  kind: string,
  options: Readonly<Record<string, unknown>>,
  rule?: TargetIdentityRule,
): string {
  const boundOptions =
    rule === undefined
      ? options
      : Object.fromEntries(
          Object.entries(options).filter(([key]) => !rule.ignoredOptions.includes(key)),
        );

  const digest = createHash('sha256')
    .update(JSON.stringify(sortJSONKeys(boundOptions, 'locale')))
    .digest('hex')
    .slice(0, 16);

  return rule === undefined ? `${kind}:${digest}` : `${kind}:${rule.version}:${digest}`;
}
