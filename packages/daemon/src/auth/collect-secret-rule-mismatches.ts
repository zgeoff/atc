import type { BrokerSecret, BrokerSecretKind, BrokerSecretRule } from '@atc/plugin-api';
import { match } from 'ts-pattern';
import { GITHUB_SECRET_RULES } from './github-secret-rules';

interface ExpectedSecret {
  readonly secret: string;
  readonly kind: BrokerSecretKind;
  readonly rules: readonly BrokerSecretRule[];
}

type SecretRuleMismatch =
  | { readonly secret: string; readonly reason: 'missing' }
  | {
      readonly secret: string;
      readonly reason: 'kind';
      readonly expected: BrokerSecretKind;
      readonly actual: BrokerSecretKind;
    }
  | {
      readonly secret: string;
      readonly reason: 'rules';
      readonly expected: readonly BrokerSecretRule[];
      readonly actual: readonly BrokerSecretRule[];
    }
  | { readonly secret: string; readonly reason: 'host'; readonly host: string };

export function collectSecretRuleMismatches(
  expected: readonly ExpectedSecret[],
  secrets: readonly BrokerSecret[],
): SecretRuleMismatch[] {
  const held = new Map(secrets.map((secret) => [secret.name, secret]));

  const mismatches: SecretRuleMismatch[] = [];

  // the host each matched secret sends a credential to, from the rules the
  // broker holds
  const hostOwners = new Map<string, string>();

  for (const want of expected) {
    const actual = held.get(want.secret);

    if (actual === undefined) {
      mismatches.push({ secret: want.secret, reason: 'missing' });
    } else if (!hasKind(want.kind, actual.kind)) {
      mismatches.push({
        secret: want.secret,
        reason: 'kind',
        expected: want.kind,
        actual: actual.kind,
      });
    } else if (actual.kind !== 'github' && !hasSameRules(toExpectedRules(want), actual.rules)) {
      // the broker owns a github secret's rules, so only its kind is checked
      mismatches.push({
        secret: want.secret,
        reason: 'rules',
        expected: toExpectedRules(want),
        actual: actual.rules,
      });
    } else {
      // two secrets on one host leave the broker to pick the credential
      const shared = actual.rules.find((rule) => hostOwners.has(rule.host));

      if (shared === undefined) {
        for (const rule of actual.rules) {
          hostOwners.set(rule.host, want.secret);
        }
      } else {
        mismatches.push({ secret: want.secret, reason: 'host', host: shared.host });
      }
    }
  }

  return mismatches;
}

// A newer broker stores every kind but oauth as `static`, and rewrites the
// stored secrets of the older kinds in place when it upgrades.
function hasKind(expected: BrokerSecretKind, actual: BrokerSecretKind): boolean {
  return match(expected)
    .returnType<boolean>()
    .with('anthropic', 'custom', 'github', 'npm', (kind) => actual === kind || actual === 'static')
    .with('oauth', 'static', (kind) => actual === kind)
    .exhaustive();
}

function hasSameRules(
  left: readonly BrokerSecretRule[],
  right: readonly BrokerSecretRule[],
): boolean {
  const leftKeys = left.map((rule) => toRuleKey(rule)).toSorted();
  const rightKeys = right.map((rule) => toRuleKey(rule)).toSorted();

  // a held rule the binding lacks is a mismatch too: it sends the credential
  // to a host the binding never approved
  return (
    leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
  );
}

// A rule as one comparable string; JSON keeps a missing user apart from
// any user a basic rule can hold.
function toRuleKey(rule: BrokerSecretRule): string {
  return JSON.stringify([rule.host, rule.header, rule.scheme, rule.user ?? null]);
}

// A binding holds no rules for a github secret. A newer broker lists one as
// `static` and holds its rules as ordinary rules, so they are compared with
// the github rules.
function toExpectedRules(want: ExpectedSecret): readonly BrokerSecretRule[] {
  return match(want.kind)
    .returnType<readonly BrokerSecretRule[]>()
    .with('github', () => GITHUB_SECRET_RULES)
    .with('anthropic', 'custom', 'npm', 'oauth', 'static', () => want.rules)
    .exhaustive();
}
