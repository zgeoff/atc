import { SESSION_ENV_NAMES } from '@atc/protocol/session';

// The variables atc sets for the harness of a session it hosts.
const SESSION_VARIABLES: ReadonlySet<string> = new Set(Object.values(SESSION_ENV_NAMES));

/**
 * Copies an environment without the session environment of whoever runs
 * the restart, so the daemon it starts never mistakes itself for a hosted
 * session. Entries with no value drop out.
 */
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
