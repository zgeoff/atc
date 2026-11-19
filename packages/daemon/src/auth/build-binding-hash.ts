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

  // Empty parts are left out so the hashes of bindings stored earlier stay unchanged.
  const hashed = {
    secrets,
    ...(Object.keys(profileEnv).length === 0 ? {} : { profileEnv }),
    ...(binding.telemetryHost === null ? {} : { telemetryHost: binding.telemetryHost }),
  };

  return createHash('sha256')
    .update(JSON.stringify(sortJSONKeys(hashed, 'locale')))
    .digest('hex');
}
