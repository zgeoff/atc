import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LEGACY_BROKER_PLACEHOLDER } from '@atc/config';
import { BROKER_PLACEHOLDER, sortJSONKeys } from '@atc/core';
import { GITHUB_SECRET_RULES } from './github-secret-rules';

// The parts of a binding its hash covers.
interface HashedBinding {
  readonly secrets: readonly { readonly kind: string; readonly rules: readonly unknown[] }[];
  readonly profileEnv: Readonly<Record<string, string>>;
}

// An older atc stored a github secret's rules in its binding. They hash as no
// rules, because the broker's github secret holds the same rules itself, and
// the old placeholder hashes as the current one, since neither is a credential.
export function buildBindingHash(binding: HashedBinding): string {
  const secrets = binding.secrets.map((secret) =>
    secret.kind === 'github' && isDeepStrictEqual(secret.rules, GITHUB_SECRET_RULES)
      ? { ...secret, rules: [] }
      : secret,
  );

  const profileEnv = Object.fromEntries(
    Object.entries(binding.profileEnv).map(([key, value]) => [
      key,
      value === LEGACY_BROKER_PLACEHOLDER ? BROKER_PLACEHOLDER : value,
    ]),
  );

  const hashed = Object.keys(profileEnv).length === 0 ? { secrets } : { secrets, profileEnv };

  return createHash('sha256')
    .update(JSON.stringify(sortJSONKeys(hashed, 'locale')))
    .digest('hex');
}
