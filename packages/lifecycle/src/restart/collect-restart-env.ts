import { SESSION_ENV_NAMES } from '@atcx/contract/light';

const SESSION_VARIABLES: ReadonlySet<string> = new Set(Object.values(SESSION_ENV_NAMES));

export function collectRestartEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const copy: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SESSION_VARIABLES.has(key)) {
      copy[key] = value;
    }
  }

  return copy;
}
