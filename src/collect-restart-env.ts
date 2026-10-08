// The variables atc sets for the harness of a session it hosts.
const SESSION_VARIABLES = new Set(['ATC_SESSION_ID', 'ATC_SOCKET', 'ATC_SESSION_RECORD']);

/**
 * Copies an environment without the variables that name the session, its
 * record, or the socket of whoever runs the restart, so the daemon it starts never mistakes
 * itself for a hosted session. Entries with no value drop out.
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
