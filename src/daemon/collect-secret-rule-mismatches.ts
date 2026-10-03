import type { ImpSecret, ImpSecretRule } from './imp-port';

/**
 * One secret as a resolved binding expects impd to hold it: its kind and
 * the complete set of rules, one per host.
 */
export interface ExpectedSecret {
  readonly secret: string;
  readonly kind: ImpSecret['kind'];
  readonly rules: readonly ImpSecretRule[];
}

export type SecretRuleMismatch =
  | { readonly secret: string; readonly reason: 'missing' }
  | {
      readonly secret: string;
      readonly reason: 'kind';
      readonly expected: ImpSecret['kind'];
      readonly actual: ImpSecret['kind'];
    }
  | {
      readonly secret: string;
      readonly reason: 'rules';
      readonly expected: readonly ImpSecretRule[];
      readonly actual: readonly ImpSecretRule[];
    };

/**
 * Compares the secrets a resolved binding expects with the secrets impd
 * lists, secret by secret. Each expected secret must exist with the same
 * kind and exactly the same set of rules, in any order: a rule impd holds
 * that the binding lacks is a mismatch as much as a missing one, since it
 * sends the credential to a host the binding never approved. An empty
 * result means every expected secret matches; secrets the binding does not
 * expect are ignored.
 */
export function collectSecretRuleMismatches(
  expected: readonly ExpectedSecret[],
  secrets: readonly ImpSecret[],
): SecretRuleMismatch[] {
  const held = new Map(secrets.map((secret) => [secret.name, secret]));

  const mismatches: SecretRuleMismatch[] = [];

  for (const want of expected) {
    const actual = held.get(want.secret);

    if (actual === undefined) {
      mismatches.push({ secret: want.secret, reason: 'missing' });
    } else if (actual.kind !== want.kind) {
      mismatches.push({
        secret: want.secret,
        reason: 'kind',
        expected: want.kind,
        actual: actual.kind,
      });
    } else if (!hasSameRules(want.rules, actual.rules)) {
      mismatches.push({
        secret: want.secret,
        reason: 'rules',
        expected: want.rules,
        actual: actual.rules,
      });
    }
  }

  return mismatches;
}

function hasSameRules(left: readonly ImpSecretRule[], right: readonly ImpSecretRule[]): boolean {
  const leftKeys = left.map((rule) => toRuleKey(rule)).toSorted();
  const rightKeys = right.map((rule) => toRuleKey(rule)).toSorted();

  return (
    leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
  );
}

// A rule as one comparable string; JSON keeps a missing user apart from
// any user a basic rule can hold.
function toRuleKey(rule: ImpSecretRule): string {
  return JSON.stringify([rule.host, rule.header, rule.scheme, rule.user ?? null]);
}
