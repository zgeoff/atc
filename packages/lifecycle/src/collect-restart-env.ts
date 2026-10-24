import { SESSION_ENV_NAMES } from '@atcx/contract/light';

// The variables atc sets for the harness of a session it hosts.
const SESSION_VARIABLES: ReadonlySet<string> = new Set(Object.values(SESSION_ENV_NAMES));

// the caller's session variables are dropped so the daemon it starts never
// mistakes itself for a hosted session.
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
