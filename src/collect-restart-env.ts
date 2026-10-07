/**
 * Copies an environment without the variables that name the session or
 * socket of whoever runs the restart, so the daemon it starts never mistakes
 * itself for a hosted session. Entries with no value drop out.
 */
export function collectRestartEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const copy: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key !== 'ATC_SESSION_ID' && key !== 'ATC_SOCKET') {
      copy[key] = value;
    }
  }

  return copy;
}
