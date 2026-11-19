import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LEGACY_BROKER_PLACEHOLDER } from '@atc/config';
import { BROKER_PLACEHOLDER, sortJSONKeys } from '@atc/core';
import { GITHUB_SECRET_RULES } from './github-secret-rules';

interface HashedBinding {
  readonly secrets: readonly { readonly kind: string; readonly rules: readonly unknown[] }[];
  readonly profileEnv: Readonly<Record<string, string>>;
  readonly telemetryHost: string | null;
}

// A github secret's rules hash as no rules, since the broker's github secret holds the same rules.
// The legacy placeholder hashes as the current one, so stored bindings keep their hash.
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

  // An empty part is left out of the hash so a binding stored before that part existed keeps its
  // hash.
  const hashed = {
    secrets,
    ...(Object.keys(profileEnv).length === 0 ? {} : { profileEnv }),
    ...(binding.telemetryHost === null ? {} : { telemetryHost: binding.telemetryHost }),
  };

  return createHash('sha256')
    .update(JSON.stringify(sortJSONKeys(hashed, 'locale')))
    .digest('hex');
}
